import { prisma } from "./db";
import { decryptNullable } from "./src/lib/encrypt";
import { Storage } from "@google-cloud/storage";
import * as path from "path";
import * as fs from "fs";
import JSZip from "jszip";

/**
 * Download the template file from GCS (or local), pre-fill all {{TOKEN}} placeholders
 * directly in the document XML/text, and return as a Buffer ready for multipart upload.
 * Pre-filling avoids PandaDoc interpreting {{DATE}} as a reserved date field type.
 */
async function prepareFilledDocument(
  fileUrl: string,
  tokens: Record<string, string>,
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  // Download the raw file
  let buffer: Buffer;
  let contentType: string;
  const filename = decodeURIComponent(fileUrl.split("/").pop()?.split("?")[0] || "agreement");

  const gcsMatch = fileUrl.match(/storage\.googleapis\.com\/([^/]+)\/(.+)/);
  if (gcsMatch) {
    const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
    if (!keyJson) throw new Error("GCS_SERVICE_ACCOUNT_KEY not configured");
    const credentials = JSON.parse(keyJson);
    const storage = new Storage({ credentials });
    const objectPath = gcsMatch[2];
    const file = storage.bucket(gcsMatch[1]).file(objectPath);
    const [meta] = await file.getMetadata();
    const [contents] = await file.download();
    buffer = contents;
    contentType = (meta.contentType as string) || "application/octet-stream";
  } else if (fileUrl.startsWith("/uploads/")) {
    const localPath = path.join(process.cwd(), "public", fileUrl);
    buffer = fs.readFileSync(localPath);
    contentType = filename.endsWith(".pdf") ? "application/pdf"
      : filename.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/msword";
  } else {
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`Failed to fetch template: ${resp.status}`);
    buffer = Buffer.from(await resp.arrayBuffer());
    contentType = resp.headers.get("content-type") || "application/octet-stream";
  }

  const isDocx = contentType.includes("wordprocessingml") || filename.endsWith(".docx") || filename.endsWith(".doc");
  const isPdf = contentType.includes("pdf") || filename.endsWith(".pdf");

  console.log(`[DOCX] isDocx=${isDocx}, isPdf=${isPdf}, contentType=${contentType}, filename=${filename}`);
  if (isDocx) {
    // Replace {{TOKEN}} in Word XML directly - avoids PandaDoc reserved keyword conflicts
    const zip = await JSZip.loadAsync(buffer);
    console.log(`[DOCX] ZIP files: ${Object.keys(zip.files).join(", ")}`);
    const xmlFiles = ["word/document.xml", "word/header1.xml", "word/header2.xml", "word/footer1.xml", "word/footer2.xml"];
    for (const xmlFile of xmlFiles) {
      if (zip.files[xmlFile]) {
        let content = await zip.files[xmlFile].async("string");

        // Word splits tokens across XML runs in unpredictable ways.
        // e.g. {{CLIENT1_NAME}} may appear as <w:t>{</w:t><w:t>{CLIENT1</w:t><w:t>_NAME}}</w:t>
        // Fix: for each paragraph, extract plain text, replace tokens, rebuild with a single run.
        content = content.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (para: string) => {
          // Extract all text from <w:t> elements in this paragraph
          const plainText = (para.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
            .map((t: string) => t.replace(/<[^>]+>/g, ""))
            .join("");

          // Only process paragraphs that contain tokens
          if (!plainText.includes("{{")) return para;

          console.log(`[DOCX] Found token paragraph, plainText: "${plainText.substring(0, 200)}"`);

          // Replace tokens in plain text
          let replaced = plainText;
          for (const [name, value] of Object.entries(tokens)) {
            replaced = replaced.split(`{{${name}}}`).join(value || "");
          }

          console.log(`[DOCX] After replacement: "${replaced.substring(0, 200)}"`);

          // If nothing changed, return original paragraph
          if (replaced === plainText) {
            console.log(`[DOCX] WARNING: No tokens replaced in paragraph: "${plainText.substring(0, 200)}"`);
            return para;
          }

          // Preserve paragraph properties (<w:pPr>...</w:pPr>) and rebuild with single run
          const pPrMatch = para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
          const pPr = pPrMatch ? pPrMatch[0] : "";
          // Extract run properties from first run for font/style preservation
          const rPrMatch = para.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
          const rPr = rPrMatch ? rPrMatch[0] : "";
          const escapedText = replaced
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          return `<w:p><w:pPr>${pPr ? pPr.replace(/<\/?w:pPr>/g, "") : ""}</w:pPr><w:r>${rPr}<w:t xml:space="preserve">${escapedText}</w:t></w:r></w:p>`;
        });

        zip.file(xmlFile, content);
      }
    }
    const filled = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return { buffer: filled, filename, contentType };
  }

  if (isPdf) {
    // For PDFs we can't do XML replacement - return as-is
    // Providers should use Word docs for token replacement
    return { buffer, filename, contentType };
  }

  return { buffer, filename, contentType };
}

interface GenerateAgreementParams {
  providerId: string;
  parentUserId: string;
  sessionId: string;
  generatedByUserId?: string;
  partnerOverride?: {
    firstName: string;
    lastName: string;
    email: string;
  };
  skipPartner?: boolean;
}

async function waitForDocumentStatus(apiKey: string, documentId: string, targetStatus: string, maxAttempts = 15): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const res = await fetch(`https://api.pandadoc.com/public/v1/documents/${documentId}`, {
      headers: { "Authorization": `API-Key ${apiKey}` },
    });
    if (res.ok) {
      const doc = await res.json();
      console.log(`[PandaDoc] Poll ${i + 1}/${maxAttempts}: status=${doc.status} (waiting for ${targetStatus})`);
      if (doc.status === targetStatus) return true;
      if (doc.status === "document.error") {
        console.error("[PandaDoc] Document entered error state");
        return false;
      }
    } else {
      console.warn(`[PandaDoc] Poll ${i + 1} fetch failed: ${res.status}`);
    }
  }
  return false;
}

/**
 * Fetch roles and per-role field counts from a PandaDoc template's details endpoint.
 * Roles are returned sorted by signing_order ascending.
 */
async function fetchTemplateRolesAndFields(
  apiKey: string,
  templateId: string,
): Promise<{
  roles: Array<{ id: string; name: string; signingOrder: number }>;
  fieldCountByRoleId: Record<string, number>;
}> {
  const res = await fetch(`https://api.pandadoc.com/public/v1/templates/${templateId}/details`, {
    headers: { "Authorization": `API-Key ${apiKey}` },
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`PandaDoc template details failed: ${res.status} - ${errBody}`);
  }
  const data = await res.json();

  // PandaDoc document creation API requires signing_order >= 1.
  // Template detail API may return 0 or null for signing_order (0-based or unset),
  // so we sort by whatever value we get, then re-assign 1-based sequential order.
  const roles = ((data.roles || []) as any[])
    .map((r: any) => ({
      id: String(r.id),
      name: String(r.name),
      signingOrder: Number(r.signing_order ?? 0),
    }))
    .sort((a, b) => a.signingOrder - b.signingOrder)
    .map((r, i) => ({ ...r, signingOrder: i + 1 }));

  const fieldCountByRoleId: Record<string, number> = {};
  for (const field of (data.fields || []) as any[]) {
    const assignedTo = field.assigned_to;
    if (assignedTo?.type === "role" && assignedTo?.id) {
      const rid = String(assignedTo.id);
      fieldCountByRoleId[rid] = (fieldCountByRoleId[rid] || 0) + 1;
    }
  }

  return { roles, fieldCountByRoleId };
}

export async function fetchDocumentViewUrl(apiKey: string, documentId: string, recipientEmail: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`https://api.pandadoc.com/public/v1/documents/${documentId}/session`, {
      method: "POST",
      headers: {
        "Authorization": `API-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient: recipientEmail, lifetime: 86400, type: "SIGNER" }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      console.log("[PandaDoc] Session created:", JSON.stringify(data));
      return data.id ? `https://app.pandadoc.com/s/${data.id}?embedded=1` : null;
    } else {
      const errBody = await res.text();
      console.error("[PandaDoc] Session create failed:", res.status, errBody);
    }
  } catch (e: any) {
    console.error("[PandaDoc] Session create exception:", e?.message);
  }
  return null;
}

export async function generateAgreement({ providerId, parentUserId, sessionId }: GenerateAgreementParams) {
  const [provider, parentUser, session] = await Promise.all([
    prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true, name: true, email: true, agreementTemplateUrl: true },
    }),
    prisma.user.findUnique({
      where: { id: parentUserId },
      select: { id: true, name: true, email: true, firstName: true, lastName: true, parentAccountId: true, dateOfBirth: true, address: true, city: true, state: true, zip: true, ssn: true, passport: true, passportCountryOfIssue: true, nationality: true },
    }),
    prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, providerId: true },
    }),
  ]);

  if (!provider) throw new Error("Provider not found");
  if (!parentUser) throw new Error("Parent user not found");
  if (!session) throw new Error("Chat session not found");
  if (session.providerId !== providerId) throw new Error("Provider/session mismatch");
  if (!provider.agreementTemplateUrl) throw new Error("Provider has not uploaded an agreement template");

  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY is not configured");

  // Fetch all members of the parent account to support two-parent households
  const accountMembers = parentUser.parentAccountId
    ? await prisma.user.findMany({
        where: { parentAccountId: parentUser.parentAccountId },
        select: { id: true, name: true, email: true, firstName: true, lastName: true, dateOfBirth: true, address: true, city: true, state: true, zip: true, ssn: true, passport: true, passportCountryOfIssue: true, nationality: true },
        orderBy: { createdAt: "asc" },
      })
    : [parentUser];

  const parent1 = accountMembers[0] || parentUser;
  const parent2 = accountMembers[1] || null;

  function formatMember(m: typeof parent1 | null) {
    if (!m) return { name: "", email: "", dob: "", address: "", ssn: "", passport: "", passportCountryOfIssue: "", nationality: "" };
    const name = m.name || `${m.firstName || ""} ${m.lastName || ""}`.trim() || "Intended Parent";
    const dob = m.dateOfBirth ? new Date(m.dateOfBirth).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
    const addressParts = [m.address, m.city, m.state, m.zip].filter(Boolean);
    const address = addressParts.join(", ");
    const ssn = decryptNullable(m.ssn);
    const passport = decryptNullable(m.passport);
    const passportCountryOfIssue = m.passportCountryOfIssue || "";
    const nationality = m.nationality || "";
    return { name, email: m.email || "", dob, address, ssn, passport, passportCountryOfIssue, nationality };
  }

  const p1 = formatMember(parent1);
  const p2 = formatMember(parent2);

  // Primary signer is parent1 (the one who initiated the session)
  const parentName = p1.name;
  const parentEmail = p1.email;

  const initialSignerStatus: Record<string, object> = {};
  if (p1.email) {
    initialSignerStatus[p1.email] = { completed: false, completedAt: null, viewed: false, viewedAt: null, role: null, firstName: parent1.firstName || p1.name.split(" ")[0] || null, lastName: parent1.lastName || p1.name.split(" ").slice(1).join(" ") || null };
  }
  if (p2.email) {
    initialSignerStatus[p2.email] = { completed: false, completedAt: null, viewed: false, viewedAt: null, role: null, firstName: parent2?.firstName || p2.name.split(" ")[0] || null, lastName: parent2?.lastName || p2.name.split(" ").slice(1).join(" ") || null };
  }

  const agreement = await prisma.agreement.create({
    data: {
      providerId,
      parentUserId,
      sessionId,
      status: "DRAFT",
      documentType: "Agency Agreement",
      signerStatus: Object.keys(initialSignerStatus).length > 0 ? initialSignerStatus : undefined,
    },
  });

  try {
    const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

    // Build the token map for pre-filling the document
    const tokenMap: Record<string, string> = {
      CLIENT1_NAME: p1.name,
      CLIENT1_EMAIL: p1.email,
      CLIENT1_DOB: p1.dob,
      CLIENT1_ADDRESS: p1.address,
      CLIENT1_SSN: p1.ssn,
      CLIENT1_PASSPORT: p1.passport,
      CLIENT1_PASSPORT_COUNTRY: p1.passportCountryOfIssue,
      CLIENT1_NATIONALITY: p1.nationality,
      CLIENT2_NAME: p2.name,
      CLIENT2_EMAIL: p2.email,
      CLIENT2_DOB: p2.dob,
      CLIENT2_ADDRESS: p2.address,
      CLIENT2_SSN: p2.ssn,
      CLIENT2_PASSPORT: p2.passport,
      CLIENT2_PASSPORT_COUNTRY: p2.passportCountryOfIssue,
      CLIENT2_NATIONALITY: p2.nationality,
      PROVIDER_NAME: provider.name,
      PROVIDER_EMAIL: provider.email || "",
      DATE: today,
      // Anchor strings replaced into the document; the fields config below tells PandaDoc
      // to overlay interactive widgets wherever these strings appear.
      SIGNATURE_1: "___SIGN1___",
      SIGNATURE_2: "___SIGN2___",
      INITIALS_1: "___INI1___",
      INITIALS_2: "___INI2___",
      PROVIDER_SIGNATURE: "___SIGN3___",
    };

    // Download the template and pre-fill all {{TOKEN}} placeholders in the document XML.
    // This avoids PandaDoc treating {{DATE}} (and others) as reserved field type keywords.
    const { buffer: filledBuffer, filename, contentType } = await prepareFilledDocument(
      provider.agreementTemplateUrl!,
      tokenMap,
    );

    // Build multipart form data for the PandaDoc API
    const docMeta = {
      name: `${provider.name} - Agency Agreement - ${parentName}`,
      recipients: [
        // Client 1 - always present
        {
          email: parentEmail,
          first_name: parent1.firstName || p1.name.split(" ")[0] || "",
          last_name: parent1.lastName || p1.name.split(" ").slice(1).join(" ") || "",
          role: "signer1",
          signing_order: 1,
        },
        // Client 2 - only if second parent exists in the account
        ...(parent2 && p2.email ? [{
          email: p2.email,
          first_name: parent2.firstName || p2.name.split(" ")[0] || "",
          last_name: parent2.lastName || p2.name.split(" ").slice(1).join(" ") || "",
          role: "signer2",
          signing_order: 2,
        }] : []),
        // Provider countersigns last
        ...(provider.email ? [{
          email: provider.email,
          first_name: provider.name.split(" ")[0] || provider.name,
          last_name: provider.name.split(" ").slice(1).join(" ") || "",
          role: "signer3",
          signing_order: parent2 && p2.email ? 3 : 2,
        }] : []),
      ],
      fields: {
        // PandaDoc finds each anchor string in the rendered document and overlays the widget.
        // Role names must be lowercase and match recipient role strings exactly.
        signature_1:  { role: "signer1", type: "signature", anchor: { text: "___SIGN1___", occurrence: 1 } },
        signature_2:  { role: "signer2", type: "signature", anchor: { text: "___SIGN2___", occurrence: 1 } },
        signature_3:  { role: "signer3", type: "signature", anchor: { text: "___SIGN3___", occurrence: 1 } },
        initials_1_1: { role: "signer1", type: "initials",  anchor: { text: "___INI1___",  occurrence: 1 } },
        initials_1_2: { role: "signer1", type: "initials",  anchor: { text: "___INI1___",  occurrence: 2 } },
        initials_1_3: { role: "signer1", type: "initials",  anchor: { text: "___INI1___",  occurrence: 3 } },
        initials_1_4: { role: "signer1", type: "initials",  anchor: { text: "___INI1___",  occurrence: 4 } },
        initials_1_5: { role: "signer1", type: "initials",  anchor: { text: "___INI1___",  occurrence: 5 } },
        initials_1_6: { role: "signer1", type: "initials",  anchor: { text: "___INI1___",  occurrence: 6 } },
        initials_1_7: { role: "signer1", type: "initials",  anchor: { text: "___INI1___",  occurrence: 7 } },
        initials_1_8: { role: "signer1", type: "initials",  anchor: { text: "___INI1___",  occurrence: 8 } },
        initials_2_1: { role: "signer2", type: "initials",  anchor: { text: "___INI2___",  occurrence: 1 } },
        initials_2_2: { role: "signer2", type: "initials",  anchor: { text: "___INI2___",  occurrence: 2 } },
        initials_2_3: { role: "signer2", type: "initials",  anchor: { text: "___INI2___",  occurrence: 3 } },
        initials_2_4: { role: "signer2", type: "initials",  anchor: { text: "___INI2___",  occurrence: 4 } },
        initials_2_5: { role: "signer2", type: "initials",  anchor: { text: "___INI2___",  occurrence: 5 } },
        initials_2_6: { role: "signer2", type: "initials",  anchor: { text: "___INI2___",  occurrence: 6 } },
        initials_2_7: { role: "signer2", type: "initials",  anchor: { text: "___INI2___",  occurrence: 7 } },
        initials_2_8: { role: "signer2", type: "initials",  anchor: { text: "___INI2___",  occurrence: 8 } },
      },
      metadata: {
        gostork_provider_id: providerId,
        gostork_parent_user_id: parentUserId,
        gostork_session_id: sessionId,
        gostork_agreement_id: agreement.id,
      },
      tags: ["gostork"],
      parse_form_fields: false,
    };

    const formData = new FormData();
    formData.append("data", JSON.stringify(docMeta));
    formData.append("file", new Blob([filledBuffer as unknown as ArrayBuffer], { type: contentType }), filename);

    const createResponse = await fetch("https://api.pandadoc.com/public/v1/documents", {
      method: "POST",
      headers: { "Authorization": `API-Key ${apiKey}` },
      body: formData,
    });

    if (!createResponse.ok) {
      const errorBody = await createResponse.text();
      console.error("[PandaDoc] Document creation failed:", createResponse.status, errorBody);
      throw new Error(`PandaDoc API error: ${createResponse.status} - ${errorBody}`);
    }

    const pandaDocResult = await createResponse.json();
    console.log("[PandaDoc] Document created:", JSON.stringify({ id: pandaDocResult.id, status: pandaDocResult.status, recipients: pandaDocResult.recipients?.map((r: any) => r.email) }));
    const pandaDocDocumentId = pandaDocResult.id;

    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { pandaDocDocumentId },
    });

    // Diagnostic: log what fields PandaDoc detected in the creation response
    console.log("[PandaDoc] Creation fields:", JSON.stringify(pandaDocResult.fields ?? "none"));
    console.log("[PandaDoc] Full creation response keys:", Object.keys(pandaDocResult).join(", "));

    // Wait for document to reach draft status
    const isReady = await waitForDocumentStatus(apiKey, pandaDocDocumentId, "document.draft");

    // Diagnostic: fetch document details and fields after reaching draft
    const detailRes = await fetch(`https://api.pandadoc.com/public/v1/documents/${pandaDocDocumentId}/fields`, {
      headers: { "Authorization": `API-Key ${apiKey}` },
    });
    const detailBody = await detailRes.text();
    console.log("[PandaDoc] Fields endpoint response:", detailRes.status, detailBody.substring(0, 500));

    if (!isReady) {
      console.warn("[PandaDoc] Document did not reach draft state, marking as CREATED");
      await prisma.agreement.update({
        where: { id: agreement.id },
        data: { status: "CREATED" },
      });
      return await prisma.agreement.findUnique({ where: { id: agreement.id } });
    }

    // Send with silent:true - suppresses PandaDoc's own notification email.
    // GoStork delivers the signing link via our own branded email + chat card instead.
    const sendResponse = await fetch(`https://api.pandadoc.com/public/v1/documents/${pandaDocDocumentId}/send`, {
      method: "POST",
      headers: {
        "Authorization": `API-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `Hi ${parentName}, please review and sign your agreement with ${provider.name}. Once you sign, ${provider.name} will countersign to complete the agreement. If you have any questions, reach out through your GoStork chat.`,
        silent: true,
      }),
    });

    if (!sendResponse.ok) {
      const errorBody = await sendResponse.text();
      console.error("[PandaDoc] Document send failed:", sendResponse.status, errorBody);
      await prisma.agreement.update({
        where: { id: agreement.id },
        data: { status: "CREATED" },
      });
      return await prisma.agreement.findUnique({ where: { id: agreement.id } });
    }

    // Document is now sent - create a signing session URL for the parent
    // Session requires document to be in sent state
    const pandaDocViewUrl = await fetchDocumentViewUrl(apiKey, pandaDocDocumentId, parentEmail);
    console.log(`[PandaDoc] Signing session URL: ${pandaDocViewUrl}`);

    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { status: "SENT", ...(pandaDocViewUrl ? { pandaDocViewUrl } : {}) },
    });

    return await prisma.agreement.findUnique({ where: { id: agreement.id } });
  } catch (error) {
    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { status: "ERROR" },
    }).catch(() => {});
    throw error;
  }
}

// ---- New PandaDoc template-based functions ----

/**
 * Upload provider's Word/PDF template to PandaDoc as a reusable template.
 * Stores the resulting template UUID on provider.pandaDocTemplateId.
 */
/**
 * Upload provider's file to PandaDoc as a template, embedding role names in the creation payload.
 * Stores the resulting template UUID in pandaDocTemplateId.
 */
export async function syncTemplateToPandaDoc(providerId: string): Promise<string> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { id: true, name: true, agreementTemplateUrl: true, pandaDocTemplateId: true },
  });
  if (!provider) throw new Error("Provider not found");
  if (!provider.agreementTemplateUrl) throw new Error("Provider has not uploaded an agreement template");

  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY is not configured");

  // If a valid template already exists in PandaDoc, reuse it - preserves field assignments
  if (provider.pandaDocTemplateId) {
    const checkRes = await fetch(`https://api.pandadoc.com/public/v1/templates/${provider.pandaDocTemplateId}`, {
      headers: { "Authorization": `API-Key ${apiKey}` },
    });
    if (checkRes.ok) {
      console.log(`[PandaDoc] Reusing existing template: ${provider.pandaDocTemplateId}`);
      return provider.pandaDocTemplateId;
    }
    // Template not found in PandaDoc (deleted externally) - clear DB and re-create
    console.log(`[PandaDoc] Template ${provider.pandaDocTemplateId} not found in PandaDoc, creating new one`);
    await prisma.provider.update({ where: { id: providerId }, data: { pandaDocTemplateId: null } });
  }

  // Download the file
  const fileUrl = provider.agreementTemplateUrl;
  let buffer: Buffer;
  let contentType: string;
  const filename = decodeURIComponent(fileUrl.split("/").pop()?.split("?")[0] || "agreement-template");

  const gcsMatch = fileUrl.match(/storage\.googleapis\.com\/([^/]+)\/(.+)/);
  if (gcsMatch) {
    const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
    if (!keyJson) throw new Error("GCS_SERVICE_ACCOUNT_KEY not configured");
    const credentials = JSON.parse(keyJson);
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage({ credentials });
    const file = storage.bucket(gcsMatch[1]).file(gcsMatch[2]);
    const [meta] = await file.getMetadata();
    const [contents] = await file.download();
    buffer = contents;
    contentType = (meta.contentType as string) || "application/octet-stream";
  } else if (fileUrl.startsWith("/uploads/")) {
    const localPath = path.join(process.cwd(), "public", fileUrl);
    buffer = fs.readFileSync(localPath);
    contentType = filename.endsWith(".pdf") ? "application/pdf"
      : filename.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/msword";
  } else {
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`Failed to fetch template file: ${resp.status}`);
    buffer = Buffer.from(await resp.arrayBuffer());
    contentType = resp.headers.get("content-type") || "application/octet-stream";
  }

  const templateMeta: any = {
    name: `${provider.name} Agreement Template`,
  };

  const formData = new FormData();
  formData.append("data", JSON.stringify(templateMeta));
  formData.append("file", new Blob([buffer as unknown as ArrayBuffer], { type: contentType }), filename);

  const createRes = await fetch("https://api.pandadoc.com/public/v1/templates", {
    method: "POST",
    headers: { "Authorization": `API-Key ${apiKey}` },
    body: formData,
  });

  if (!createRes.ok) {
    const errBody = await createRes.text();
    throw new Error(`PandaDoc template upload failed: ${createRes.status} - ${errBody}`);
  }

  const created = await createRes.json();
  const templateId: string = created.uuid || created.id;
  if (!templateId) throw new Error("PandaDoc did not return a template ID");
  console.log(`[PandaDoc] Template created: ${templateId}`);

  // Poll until active
  for (let i = 0; i < 15; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const pollRes = await fetch(`https://api.pandadoc.com/public/v1/templates/${templateId}`, {
      headers: { "Authorization": `API-Key ${apiKey}` },
    });
    if (pollRes.ok) {
      const tmpl = await pollRes.json();
      console.log(`[PandaDoc] Template poll ${i + 1}/15: status=${tmpl.status}`);
      if (tmpl.status === "template.active" || tmpl.status === "template.PROCESSED") break;
    }
  }

  await prisma.provider.update({
    where: { id: providerId },
    data: { pandaDocTemplateId: templateId },
  });

  return templateId;
}

/**
 * Create an embedded editing session for the provider's PandaDoc template.
 */
export async function createTemplateEditingSession(providerId: string, userEmail: string): Promise<string> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { pandaDocTemplateId: true },
  });
  if (!provider) throw new Error("Provider not found");
  if (!provider.pandaDocTemplateId) throw new Error("Provider template not synced to PandaDoc yet");

  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY is not configured");

  const res = await fetch(`https://api.pandadoc.com/public/v1/templates/${provider.pandaDocTemplateId}/editing-sessions`, {
    method: "POST",
    headers: { "Authorization": `API-Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`PandaDoc editing session failed: ${res.status} - ${errBody}`);
  }

  const data = await res.json();
  console.log("[PandaDoc] Editing session response:", JSON.stringify(data));
  const eToken: string = data.token || data.key || data.id;
  if (!eToken) throw new Error("PandaDoc did not return an editing session token");
  return eToken;
}

/**
 * After a document reaches draft state, find and DELETE any placeholder recipients
 * (identified by their @gostork.internal emails). PandaDoc auto-unassigns all fields
 * belonging to a deleted recipient. Must be called only while document is in draft.
 */
async function removePlaceholderRecipients(
  apiKey: string,
  documentId: string,
  placeholderEmails: string[],
): Promise<void> {
  if (placeholderEmails.length === 0) return;

  const detailRes = await fetch(`https://api.pandadoc.com/public/v1/documents/${documentId}/details`, {
    headers: { "Authorization": `API-Key ${apiKey}` },
  });
  if (!detailRes.ok) {
    const body = await detailRes.text();
    throw new Error(`Failed to fetch document details for recipient removal: ${detailRes.status} - ${body}`);
  }
  const detail = await detailRes.json();
  const allRecipients: Array<{ id: string; email: string }> = detail.recipients || [];

  for (const email of placeholderEmails) {
    const recipient = allRecipients.find(r => r.email === email);
    if (!recipient) {
      // Fail hard - if we can't find the placeholder we can't guarantee a clean document
      throw new Error(`Placeholder recipient not found in document: ${email}. Cannot proceed with send.`);
    }
    const delRes = await fetch(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/recipients/${recipient.id}`,
      {
        method: "DELETE",
        headers: { "Authorization": `API-Key ${apiKey}` },
      },
    );
    if (!delRes.ok) {
      const errBody = await delRes.text();
      throw new Error(
        `Failed to remove placeholder recipient ${email} (id=${recipient.id}): ${delRes.status} - ${errBody}`,
      );
    }
    console.log(`[PandaDoc] Removed placeholder recipient ${email} (id=${recipient.id}) - fields auto-unassigned`);
  }
}

/**
 * Generate an agreement from the provider's saved PandaDoc template (template-based flow).
 * Creates the document with template_uuid so all fields the provider placed in the editor
 * are preserved. Roles are fetched live from the template details API and recipients are
 * assigned accordingly.
 */
export async function generateAgreementFromTemplate({ providerId, parentUserId, sessionId, generatedByUserId, partnerOverride, skipPartner }: GenerateAgreementParams) {
  const [provider, parentUser, session] = await Promise.all([
    prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true, name: true, email: true, agreementTemplateUrl: true, pandaDocTemplateId: true, pandaDocRoles: true },
    }),
    prisma.user.findUnique({
      where: { id: parentUserId },
      // relationshipStatus values: "Single" | "Partnered" | "Married" | null
      select: { id: true, name: true, email: true, firstName: true, lastName: true, relationshipStatus: true, parentAccountId: true, dateOfBirth: true, address: true, city: true, state: true, zip: true, ssn: true, passport: true, passportCountryOfIssue: true, nationality: true },
    }),
    prisma.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { id: true, providerId: true },
    }),
  ]);

  if (!provider) throw new Error("Provider not found");
  if (!parentUser) throw new Error("Parent user not found");
  if (!session) throw new Error("Chat session not found");
  if (session.providerId !== providerId) throw new Error("Provider/session mismatch");
  if (!provider.agreementTemplateUrl) throw new Error("Provider has not uploaded an agreement template.");
  if (!provider.pandaDocTemplateId) {
    throw new Error("Please open the editor, assign signature fields, and click Save before sending an agreement.");
  }

  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY is not configured");

  const accountMembers = parentUser.parentAccountId
    ? await prisma.user.findMany({
        where: { parentAccountId: parentUser.parentAccountId },
        select: { id: true, name: true, email: true, firstName: true, lastName: true, dateOfBirth: true, address: true, city: true, state: true, zip: true, ssn: true, passport: true, passportCountryOfIssue: true, nationality: true },
        orderBy: { createdAt: "asc" },
      })
    : [parentUser];

  const parent1 = accountMembers[0] || parentUser;
  const parent2 = accountMembers[1] || null;

  function formatMember(m: typeof parent1 | null) {
    if (!m) return { name: "", email: "", dob: "", address: "", ssn: "", passport: "", passportCountryOfIssue: "", nationality: "" };
    const name = m.name || `${m.firstName || ""} ${m.lastName || ""}`.trim() || "Intended Parent";
    const dob = m.dateOfBirth ? new Date(m.dateOfBirth).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
    const addressParts = [m.address, m.city, m.state, m.zip].filter(Boolean);
    const address = addressParts.join(", ");
    const ssn = decryptNullable(m.ssn);
    const passport = decryptNullable(m.passport);
    const passportCountryOfIssue = m.passportCountryOfIssue || "";
    const nationality = m.nationality || "";
    return { name, email: m.email || "", dob, address, ssn, passport, passportCountryOfIssue, nationality };
  }

  const p1 = formatMember(parent1);

  const parent1Name = p1.name;
  const parent1Email = p1.email;

  // ── Role resolution (done before creating the agreement record so Case D can throw cleanly) ──

  // Primary: use cached pandaDocRoles when single-role (no field counts needed).
  // 2+ cached roles or no cache: fetch live for field counts needed by provider-role detection.
  let roles: Array<{ id: string; name: string; signingOrder: number }> = [];
  let fieldCountByRoleId: Record<string, number> = {};

  let cachedNames: string[] | null = null;
  try {
    if (provider.pandaDocRoles) {
      const parsed = JSON.parse(provider.pandaDocRoles);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((n: unknown) => typeof n === "string")) {
        cachedNames = parsed as string[];
      }
    }
  } catch {
    // ignore parse errors, fall through to live fetch
  }

  if (cachedNames && cachedNames.length === 1) {
    roles = [{ id: "cached", name: cachedNames[0], signingOrder: 1 }];
    console.log(`[PandaDoc] Using cached single role (no live fetch): "${cachedNames[0]}"`);
  } else {
    const fetched = await fetchTemplateRolesAndFields(apiKey, provider.pandaDocTemplateId);
    roles = fetched.roles;
    fieldCountByRoleId = fetched.fieldCountByRoleId;
    const reason = cachedNames ? `${cachedNames.length} cached roles - fetching live for field counts` : "no valid role cache - fetching live";
    console.log(`[PandaDoc] ${reason}`);
    console.log(`[PandaDoc] Roles from template: ${JSON.stringify(roles.map(r => r.name))}`);
    console.log(`[PandaDoc] Field counts: ${JSON.stringify(fieldCountByRoleId)}`);
  }

  if (roles.length === 0) {
    throw new Error("No roles found on the template. Open the editor, create at least one role, assign your signature fields to it, and click Save.");
  }

  // ── Provider-role detection (keyword-only; no field-count heuristics) ──
  const PROVIDER_KEYWORDS = ["agency", "provider", "clinic", "attorney", "counsel", "lawyer", "principal", "staff", "admin", "weltman", "law group"];
  let providerRole: { id: string; name: string; signingOrder: number } | null = null;

  const keywordMatch = roles.find(r => {
    const lower = r.name.toLowerCase();
    return PROVIDER_KEYWORDS.some(k => lower.includes(k));
  });

  if (keywordMatch) {
    const matchedKeyword = PROVIDER_KEYWORDS.find(k => keywordMatch.name.toLowerCase().includes(k))!;
    providerRole = keywordMatch;
    console.log(`[PandaDoc] Detected provider role: "${keywordMatch.name}" (reason: keyword match "${matchedKeyword}")`);
  } else {
    console.log(`[PandaDoc] No provider role detected - treating all roles as parent roles`);
  }

  const parentRoles = providerRole ? roles.filter(r => r.id !== providerRole!.id) : [...roles];

  console.log(`[PandaDoc] Parent roles: ${JSON.stringify(parentRoles.map(r => r.name))}`);
  if (providerRole && !provider.email) {
    console.warn(`[PandaDoc] Provider role "${providerRole.name}" detected but provider has no email - skipping provider recipient`);
  }

  // ── Case detection ──
  // A: 1 parent role  - assign parent1, done.
  // B: 2+ parent roles, parent is single - use placeholder recipients for extra roles then delete them.
  // C: 2+ parent roles, partner data available (account 2nd member OR partnerOverride supplied) - assign both.
  // D: 2+ parent roles, parent is partnered, but no 2nd account member and no partnerOverride - prompt frontend.
  //
  // parentIsPartnered: any status other than explicit "Single" (null = unknown = treat as partnered)
  const parentRoleCount = parentRoles.length;
  const accountHasPartner = accountMembers.length >= 2;
  const parentIsPartnered = parentUser.relationshipStatus !== "Single";
  const usingPartnerOverride = !!partnerOverride;

  let assignmentCase: "A" | "B" | "C" | "D";
  if (parentRoleCount <= 1) {
    assignmentCase = "A";
  } else if (!parentIsPartnered || skipPartner) {
    assignmentCase = "B";
  } else if (accountHasPartner || usingPartnerOverride) {
    assignmentCase = "C";
  } else {
    assignmentCase = "D";
  }

  console.log(`[PandaDoc] Parent assignment case: ${assignmentCase}, parentIsPartnered=${parentIsPartnered}, accountHasPartner=${accountHasPartner}, parentRoleCount=${parentRoleCount}, usingPartnerOverride=${usingPartnerOverride}, skipPartner=${!!skipPartner}`);

  // Case D throws before creating any agreement record - no orphaned DB rows.
  if (assignmentCase === "D") {
    throw Object.assign(new Error("PARTNER_INFO_REQUIRED"), {
      code: "PARTNER_INFO_REQUIRED",
      parent1: {
        firstName: parent1.firstName || p1.name.split(" ")[0] || "",
        lastName: parent1.lastName || p1.name.split(" ").slice(1).join(" ") || "",
        email: parent1Email,
      },
      parentRoles: parentRoles.map(r => r.name),
    });
  }

  // ── Agreement record created only after we know we can proceed ──
  // Seed signerStatus with signer names so "Sent to [Name]" displays immediately.
  const initialSignerStatus2: Record<string, object> = {};
  const addSigner = (email: string, firstName: string | null | undefined, lastName: string | null | undefined, signingOrder: number) => {
    if (!email) return;
    initialSignerStatus2[email] = { completed: false, completedAt: null, viewed: false, viewedAt: null, role: null, firstName: firstName || null, lastName: lastName || null, signingOrder };
  };
  addSigner(parent1Email, parent1.firstName || p1.name.split(" ")[0], parent1.lastName || p1.name.split(" ").slice(1).join(" ") || null, parentRoles[0]?.signingOrder ?? 1);
  if (assignmentCase === "C") {
    if (usingPartnerOverride) {
      addSigner(partnerOverride!.email, partnerOverride!.firstName, partnerOverride!.lastName, (parentRoles[1] ?? parentRoles[0])?.signingOrder ?? 2);
    } else if (parent2) {
      const p2fmt = formatMember(parent2);
      addSigner(p2fmt.email, parent2.firstName || p2fmt.name.split(" ")[0], parent2.lastName || p2fmt.name.split(" ").slice(1).join(" ") || null, (parentRoles[1] ?? parentRoles[0])?.signingOrder ?? 2);
    }
  }

  const agreement = await prisma.agreement.create({
    data: {
      providerId,
      parentUserId,
      sessionId,
      generatedByUserId: generatedByUserId ?? null,
      status: "DRAFT",
      documentType: "Agency Agreement",
      signerStatus: Object.keys(initialSignerStatus2).length > 0 ? initialSignerStatus2 : undefined,
    },
  });

  try {
    const parent1Role = parentRoles[0];

    // Build recipients array based on case.
    const providerRecipient = providerRole && provider.email
      ? [{
          email: provider.email,
          first_name: provider.name.split(" ")[0] || provider.name,
          last_name: provider.name.split(" ").slice(1).join(" ") || "",
          role: providerRole.name,
          signing_order: providerRole.signingOrder,
        }]
      : [];

    let recipients: Array<{ email: string; first_name: string; last_name: string; role: string; signing_order: number }>;
    let placeholderEmails: string[] = [];

    if (assignmentCase === "A") {
      // Single parent role - parent1 gets it.
      recipients = [
        {
          email: parent1Email,
          first_name: parent1.firstName || p1.name.split(" ")[0] || "",
          last_name: parent1.lastName || p1.name.split(" ").slice(1).join(" ") || "",
          role: parent1Role.name,
          signing_order: parent1Role.signingOrder,
        },
        ...providerRecipient,
      ];
    } else if (assignmentCase === "B") {
      // Single parent, 2+ parent roles: parent1 gets role[0], extras get placeholders.
      placeholderEmails = parentRoles.slice(1).map(r =>
        `placeholder-${r.name.toLowerCase().replace(/\s+/g, "-")}@gostork.internal`,
      );
      recipients = [
        {
          email: parent1Email,
          first_name: parent1.firstName || p1.name.split(" ")[0] || "",
          last_name: parent1.lastName || p1.name.split(" ").slice(1).join(" ") || "",
          role: parent1Role.name,
          signing_order: parent1Role.signingOrder,
        },
        ...parentRoles.slice(1).map((r, i) => ({
          email: placeholderEmails[i],
          first_name: r.name,
          last_name: "Placeholder",
          role: r.name,
          signing_order: r.signingOrder,
        })),
        ...providerRecipient,
      ];
    } else {
      // Case C: partner available from account or override.
      const parent2Role = parentRoles[1] ?? parentRoles[0];
      const p2r = usingPartnerOverride
        ? { email: partnerOverride!.email, first_name: partnerOverride!.firstName, last_name: partnerOverride!.lastName }
        : (() => {
            const p2m = parent2!;
            const p2f = formatMember(p2m);
            return {
              email: p2f.email,
              first_name: p2m.firstName || p2f.name.split(" ")[0] || "",
              last_name: p2m.lastName || p2f.name.split(" ").slice(1).join(" ") || "",
            };
          })();
      recipients = [
        {
          email: parent1Email,
          first_name: parent1.firstName || p1.name.split(" ")[0] || "",
          last_name: parent1.lastName || p1.name.split(" ").slice(1).join(" ") || "",
          role: parent1Role.name,
          signing_order: parent1Role.signingOrder,
        },
        {
          ...p2r,
          role: parent2Role.name,
          signing_order: parent2Role.signingOrder,
        },
        ...providerRecipient,
      ];
    }

    console.log(`[PandaDoc] Final recipients: ${JSON.stringify(recipients.map(r => `${r.email}(role=${r.role},order=${r.signing_order})`))}`);

    // Cache role names for next time.
    await prisma.provider.update({
      where: { id: providerId },
      data: { pandaDocRoles: JSON.stringify(roles.map(r => r.name)) },
    });

    // Create document from template (JSON, not multipart) - preserves all editor field placements.
    const createResponse = await fetch("https://api.pandadoc.com/public/v1/documents", {
      method: "POST",
      headers: { "Authorization": `API-Key ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${provider.name} - Agency Agreement - ${parent1Name}`,
        template_uuid: provider.pandaDocTemplateId,
        recipients,
        metadata: {
          gostork_provider_id: providerId,
          gostork_parent_user_id: parentUserId,
          gostork_session_id: sessionId,
          gostork_agreement_id: agreement.id,
        },
        tags: ["gostork"],
      }),
    });

    if (!createResponse.ok) {
      const errorBody = await createResponse.text();
      console.error("[PandaDoc] Template document creation failed:", createResponse.status, errorBody);
      throw new Error(`PandaDoc API error: ${createResponse.status} - ${errorBody}`);
    }

    const pandaDocResult = await createResponse.json();
    const pandaDocDocumentId = pandaDocResult.id;
    console.log("[PandaDoc] Document created:", JSON.stringify({
      id: pandaDocDocumentId,
      status: pandaDocResult.status,
      recipients: (pandaDocResult.recipients || []).map((r: any) => `${r.email}(role=${r.role ?? "none"})`),
    }));

    await prisma.agreement.update({ where: { id: agreement.id }, data: { pandaDocDocumentId } });

    const isReady = await waitForDocumentStatus(apiKey, pandaDocDocumentId, "document.draft");
    if (!isReady) {
      console.warn("[PandaDoc] Template document did not reach draft state");
      await prisma.agreement.update({ where: { id: agreement.id }, data: { status: "CREATED" } });
      return await prisma.agreement.findUnique({ where: { id: agreement.id } });
    }

    // Case B: remove placeholder recipients while document is still in draft.
    // PandaDoc auto-unassigns all fields belonging to the deleted recipient.
    if (assignmentCase === "B" && placeholderEmails.length > 0) {
      await removePlaceholderRecipients(apiKey, pandaDocDocumentId, placeholderEmails);
    }

    const sendResponse = await fetch(`https://api.pandadoc.com/public/v1/documents/${pandaDocDocumentId}/send`, {
      method: "POST",
      headers: { "Authorization": `API-Key ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Hi ${parent1Name}, please review and sign your agreement with ${provider.name}. If you have any questions, reach out through your GoStork chat.`,
        silent: true,
      }),
    });

    if (!sendResponse.ok) {
      const errorBody = await sendResponse.text();
      console.error("[PandaDoc] Template document send failed:", sendResponse.status, errorBody);
      await prisma.agreement.update({ where: { id: agreement.id }, data: { status: "CREATED" } });
      return await prisma.agreement.findUnique({ where: { id: agreement.id } });
    }

    // Wait for "sent" state before creating the signing session - earlier gives a view-only link.
    const isSent = await waitForDocumentStatus(apiKey, pandaDocDocumentId, "document.sent");
    if (!isSent) {
      console.warn("[PandaDoc] Document did not reach sent state - signing session may be view-only");
    }

    const pandaDocViewUrl = await fetchDocumentViewUrl(apiKey, pandaDocDocumentId, parent1Email);
    console.log(`[PandaDoc] Template signing session URL: ${pandaDocViewUrl}`);

    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { status: "SENT", ...(pandaDocViewUrl ? { pandaDocViewUrl } : {}) },
    });

    const dbAgreement = await prisma.agreement.findUnique({ where: { id: agreement.id } });

    // Build the list of parent signers so the route handler can email each one their personal link.
    const parentSigners: Array<{ name: string; email: string; userId: string | null; signingUrl: string | null; guestToken: string | null; signingOrder: number }> = [
      { name: parent1Name, email: parent1Email, userId: parentUserId, signingUrl: pandaDocViewUrl, guestToken: null, signingOrder: parent1Role.signingOrder },
    ];
    if (assignmentCase === "C" && parentRoles.length >= 2) {
      const parent2Role = parentRoles[1] ?? parentRoles[0];
      const p2Email = usingPartnerOverride ? partnerOverride!.email : (parent2 ? formatMember(parent2).email : null);
      const p2Name = usingPartnerOverride
        ? `${partnerOverride!.firstName} ${partnerOverride!.lastName}`.trim()
        : (parent2 ? formatMember(parent2).name : null);
      if (p2Email) {
        const p2Url = await fetchDocumentViewUrl(apiKey, pandaDocDocumentId, p2Email);
        // For partner overrides, still look up whether the email belongs to a GoStork account.
        // If it does, use their userId so they get the GoStork signing URL (not a guest link).
        const p2UserId = usingPartnerOverride
          ? ((await prisma.user.findFirst({ where: { email: p2Email }, select: { id: true } }))?.id ?? null)
          : (parent2 as any)?.id ?? null;
        // Generate a guest token only for non-GoStork signers so they get a public signing link
        const p2GuestToken = p2UserId ? null : crypto.randomUUID();
        parentSigners.push({ name: p2Name || p2Email, email: p2Email, userId: p2UserId, signingUrl: p2Url, guestToken: p2GuestToken, signingOrder: parent2Role.signingOrder });
      }
    }

    // Persist any guest tokens so the public signing endpoint can look them up
    const guestSigningTokens: Record<string, string> = {};
    for (const s of parentSigners) {
      if (s.guestToken && s.email) guestSigningTokens[s.guestToken] = s.email;
    }
    if (Object.keys(guestSigningTokens).length > 0) {
      await (prisma.agreement.update as any)({ where: { id: agreement.id }, data: { guestSigningTokens } });
    }

    return Object.assign(dbAgreement ?? {}, { parentSigners });
  } catch (error) {
    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { status: "ERROR" },
    }).catch(() => {});
    throw error;
  }
}

/**
 * Fetch the current role names from a provider's PandaDoc template and cache them
 * in provider.pandaDocRoles. Called after the provider closes the editor.
 */
export async function refreshTemplateRoles(providerId: string): Promise<{ roles: string[] }> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { pandaDocTemplateId: true },
  });
  if (!provider) throw new Error("Provider not found");
  if (!provider.pandaDocTemplateId) return { roles: [] };

  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY is not configured");

  const { roles, fieldCountByRoleId } = await fetchTemplateRolesAndFields(apiKey, provider.pandaDocTemplateId);

  const rolesWithFields = roles.filter(r => (fieldCountByRoleId[r.id] ?? 0) > 0);
  const droppedRoles = roles.filter(r => (fieldCountByRoleId[r.id] ?? 0) === 0);

  if (droppedRoles.length > 0) {
    console.log(`[PandaDoc] Dropped roles (zero fields): ${JSON.stringify(droppedRoles.map(r => r.name))}`);
  }
  console.log(`[PandaDoc] Cached roles (with fields): ${JSON.stringify(rolesWithFields.map(r => r.name))}`);

  const pandaDocRoles = rolesWithFields.length > 0 ? JSON.stringify(rolesWithFields.map(r => r.name)) : null;

  await prisma.provider.update({
    where: { id: providerId },
    data: { pandaDocRoles },
  });

  return { roles: rolesWithFields.map(r => r.name) };
}

/**
 * Get a fresh signing session URL for an existing agreement.
 * Verifies the requesting user is the parent on the agreement.
 */
export async function getAgreementSigningSession(agreementId: string, userId: string): Promise<{ signingUrl: string; sessionId: string; providerId: string | null; isProviderThread: boolean }> {
  const agreement = await prisma.agreement.findUnique({
    where: { id: agreementId },
    select: { id: true, parentUserId: true, pandaDocDocumentId: true, pandaDocViewUrl: true, sessionId: true },
  });
  if (!agreement) throw new Error("Agreement not found");

  // Allow access if the user is the primary parent OR shares the same parentAccountId (e.g. partner/Parent 2)
  if (agreement.parentUserId !== userId) {
    const [primaryParent, requestingUser] = await Promise.all([
      prisma.user.findUnique({ where: { id: agreement.parentUserId }, select: { parentAccountId: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } }),
    ]);
    const sameAccount =
      primaryParent?.parentAccountId &&
      requestingUser?.parentAccountId &&
      primaryParent.parentAccountId === requestingUser.parentAccountId;
    if (!sameAccount) throw new Error("Not authorized to access this agreement");
  }
  if (!agreement.pandaDocDocumentId) throw new Error("Agreement does not have a PandaDoc document yet");

  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY is not configured");

  const [parentUser, session] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    agreement.sessionId
      ? prisma.aiChatSession.findUnique({
          where: { id: agreement.sessionId },
          select: { providerId: true, providerJoinedAt: true, status: true },
        })
      : null,
  ]);
  if (!parentUser?.email) throw new Error("Parent user email not found");

  const url = await fetchDocumentViewUrl(apiKey, agreement.pandaDocDocumentId, parentUser.email);
  if (!url) throw new Error("Could not create signing session - document may not be in a signable state");

  const isProviderThread = !!(
    session?.providerJoinedAt ||
    session?.status === "CONSULTATION_BOOKED" ||
    session?.status === "PROVIDER_JOINED"
  );

  return {
    signingUrl: url,
    sessionId: agreement.sessionId,
    providerId: session?.providerId ?? null,
    isProviderThread,
  };
}

/**
 * Sync agreement status from PandaDoc's API.
 * Fetches the current document status and per-recipient completion state,
 * updates the DB, and returns the refreshed agreement.
 */
export async function syncAgreementStatus(agreementId: string): Promise<{ status: string; signerStatus: Record<string, any> }> {
  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY not configured");

  const agreement = await prisma.agreement.findUnique({
    where: { id: agreementId },
    select: {
      id: true, status: true, pandaDocDocumentId: true, signerStatus: true,
      sessionId: true, providerId: true, parentUserId: true,
      generatedByUserId: true,
      provider: { select: { name: true } },
      parentUser: { select: { name: true, firstName: true, lastName: true, email: true } },
    },
  });
  if (!agreement) throw new Error("Agreement not found");
  if (!agreement.pandaDocDocumentId) return { status: agreement.status, signerStatus: (agreement.signerStatus as Record<string, any>) ?? {} };
  // Already finalized - no need to poll PandaDoc
  if (agreement.status === "SIGNED") return { status: agreement.status, signerStatus: (agreement.signerStatus as Record<string, any>) ?? {} };

  const res = await fetch(`https://api.pandadoc.com/public/v1/documents/${agreement.pandaDocDocumentId}`, {
    headers: { "Authorization": `API-Key ${apiKey}` },
  });
  if (!res.ok) throw new Error(`PandaDoc API error: ${res.status}`);

  const doc = await res.json();
  const recipients: any[] = doc.recipients ?? [];

  const existing: Record<string, any> = (agreement.signerStatus as Record<string, any>) ?? {};
  const updated = { ...existing };
  const isCompleted = doc.status === "document.completed";

  for (const r of recipients) {
    if (!r.email) continue;
    const prev = existing[r.email] ?? {};
    // If the whole document is completed, mark every recipient as completed
    const completed = isCompleted ? true : r.has_completed === true;
    const completedAt = prev.completedAt ?? (completed ? new Date().toISOString() : null);
    updated[r.email] = {
      ...prev,
      completed,
      completedAt,
      role: r.role ?? prev.role ?? null,
      firstName: prev.firstName ?? r.first_name ?? null,
      lastName: prev.lastName ?? r.last_name ?? null,
    };
  }
  const newStatus = isCompleted ? "SIGNED" : agreement.status;

  const transitioningToSigned = isCompleted && agreement.status !== "SIGNED";

  await prisma.agreement.update({
    where: { id: agreement.id },
    data: {
      status: newStatus,
      signerStatus: updated,
      ...(transitioningToSigned ? { signedAt: new Date() } : {}),
    },
  });

  // If this poll is the first to detect completion, send the provider notification email.
  // The webhook handler skips when status is already SIGNED, so one of them sends - not both.
  if (transitioningToSigned && agreement.sessionId) {
    try {
      const { getNestApp } = await import("./nest-app-ref");
      const nestApp = getNestApp();
      if (nestApp) {
        const { NotificationService } = await import("./src/modules/notifications/notification.service");
        const notifService = nestApp.get(NotificationService);
        const parentName = (agreement as any).parentUser?.name ||
          `${(agreement as any).parentUser?.firstName || ""} ${(agreement as any).parentUser?.lastName || ""}`.trim() ||
          (agreement as any).parentUser?.email || "Parent";
        const providerName = (agreement as any).provider?.name || "Your Agency";
        const providerUser = (agreement as any).generatedByUserId
          ? await prisma.user.findUnique({ where: { id: (agreement as any).generatedByUserId }, select: { id: true, email: true, name: true } })
          : await prisma.user.findFirst({ where: { providerId: agreement.providerId }, select: { id: true, email: true, name: true } });
        if (providerUser?.email) {
          await notifService.sendAgreementSignedNotification({
            recipientUserId: providerUser.id,
            recipientEmail: providerUser.email,
            recipientName: providerUser.name || providerName,
            recipientRole: "provider",
            providerName,
            parentName,
            providerId: agreement.providerId,
            sessionId: agreement.sessionId,
            agreementId: agreement.id,
          });
          console.log(`[syncAgreementStatus] Sent completion email to provider: ${providerUser.email}`);
        }
      }
    } catch (err: any) {
      console.error(`[syncAgreementStatus] Failed to send provider completion email: ${err.message}`);
    }
  }

  return { status: newStatus, signerStatus: updated };
}
