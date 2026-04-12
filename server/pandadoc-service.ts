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

async function fetchDocumentViewUrl(apiKey: string, documentId: string, recipientEmail: string): Promise<string | null> {
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

  const parent1Name = p1.name;
  const parent1Email = p1.email;
  const parent2Name = p2.name;
  const parent2Email = p2.email;

  // Primary signer is parent1 (the one who initiated the session)
  const parentName = parent1Name;
  const parentEmail = parent1Email;

  const agreement = await prisma.agreement.create({
    data: {
      providerId,
      parentUserId,
      sessionId,
      status: "DRAFT",
      documentType: "Agency Agreement",
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
          email: parent1Email,
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
    formData.append("file", new Blob([filledBuffer], { type: contentType }), filename);

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
export async function syncTemplateToPandaDoc(providerId: string): Promise<string> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    select: { id: true, name: true, agreementTemplateUrl: true, pandaDocTemplateId: true },
  });
  if (!provider) throw new Error("Provider not found");
  if (!provider.agreementTemplateUrl) throw new Error("Provider has not uploaded an agreement template");

  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY is not configured");

  // If a template already exists, verify it still exists in PandaDoc before reusing.
  // If it was deleted (404), clear the ID and re-upload.
  if (provider.pandaDocTemplateId) {
    const checkRes = await fetch(`https://api.pandadoc.com/public/v1/templates/${provider.pandaDocTemplateId}`, {
      headers: { "Authorization": `API-Key ${apiKey}` },
    });
    if (checkRes.ok) {
      console.log(`[PandaDoc] Reusing existing template: ${provider.pandaDocTemplateId}`);
      return provider.pandaDocTemplateId;
    }
    console.log(`[PandaDoc] Template ${provider.pandaDocTemplateId} no longer exists (${checkRes.status}), re-uploading...`);
    await prisma.provider.update({ where: { id: providerId }, data: { pandaDocTemplateId: null } });
  }

  // Download the file (no token replacement - raw upload for template editor)
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

  // Upload to PandaDoc as a template (roles must be added via separate API calls after creation)
  const formData = new FormData();
  formData.append("data", JSON.stringify({ name: `${provider.name} Agreement Template` }));
  formData.append("file", new Blob([buffer], { type: contentType }), filename);

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

  console.log(`[PandaDoc] Template created: ${templateId}, polling for active status...`);

  // Poll until template.active
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
 * Returns the embed URL for the inline iframe editor.
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
    headers: {
      "Authorization": `API-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: userEmail }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`PandaDoc editing session failed: ${res.status} - ${errBody}`);
  }

  const data = await res.json();
  console.log("[PandaDoc] Editing session response:", JSON.stringify(data));
  // PandaDoc returns both `id` (session UUID) and `token`/`key` (the actual auth token for the editor SDK)
  const eToken: string = data.token || data.key || data.id;
  if (!eToken) throw new Error("PandaDoc did not return an editing session token");

  return eToken;
}

/**
 * Generate an agreement from the provider's PandaDoc template (template-based flow).
 * Tokens are passed as PandaDoc token variables instead of pre-filled XML.
 */
export async function generateAgreementFromTemplate({ providerId, parentUserId, sessionId }: GenerateAgreementParams) {
  const [provider, parentUser, session] = await Promise.all([
    prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true, name: true, email: true, agreementTemplateUrl: true, pandaDocTemplateId: true, pandaDocRoles: true },
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
  if (!provider.pandaDocTemplateId) throw new Error("Provider has not configured a PandaDoc template. Please sync the template first from the Documents tab.");

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
  const p2 = formatMember(parent2);

  const parent1Name = p1.name;
  const parent1Email = p1.email;

  const agreement = await prisma.agreement.create({
    data: {
      providerId,
      parentUserId,
      sessionId,
      status: "DRAFT",
      documentType: "Agency Agreement",
    },
  });

  try {
    const hasParent2 = !!(parent2 && p2.email);

    // Parse the stored role names that the provider configured in the Documents tab.
    // pandaDocRoles is a JSON string: ["Client","Client2","Agency"] - ordered by signing_order.
    // Positional assignment: 1st role = parent1, last role = provider, middle = parent2.
    let storedRoles: string[] = [];
    if (provider.pandaDocRoles) {
      try {
        storedRoles = JSON.parse(provider.pandaDocRoles as string);
      } catch {
        storedRoles = [];
      }
    }
    console.log("[PandaDoc] Stored roles:", storedRoles.join(", ") || "(none configured)");

    if (storedRoles.length < 2) {
      throw new Error(
        "Signing roles not configured. In the Documents tab, enter your role names exactly as you named them in the PandaDoc editor (e.g. 'Client' and 'Agency'), then save."
      );
    }

    const role1 = storedRoles[0];
    const role2 = (hasParent2 && storedRoles.length >= 3) ? storedRoles[1] : null;
    const role3 = storedRoles[storedRoles.length - 1];
    console.log(`[PandaDoc] Role assignment: parent1="${role1}", parent2="${role2 ?? "none"}", provider="${role3}"`);

    const recipients: any[] = [
      {
        email: parent1Email,
        first_name: parent1.firstName || p1.name.split(" ")[0] || "",
        last_name: parent1.lastName || p1.name.split(" ").slice(1).join(" ") || "",
        role: role1,
      },
    ];
    if (hasParent2 && role2) {
      recipients.push({
        email: p2.email,
        first_name: parent2!.firstName || p2.name.split(" ")[0] || "",
        last_name: parent2!.lastName || p2.name.split(" ").slice(1).join(" ") || "",
        role: role2,
      });
    }
    if (provider.email) {
      recipients.push({
        email: provider.email,
        first_name: provider.name.split(" ")[0] || provider.name,
        last_name: provider.name.split(" ").slice(1).join(" ") || "",
        role: role3,
      });
    }

    const docBody = {
      template_uuid: provider.pandaDocTemplateId,
      name: `${provider.name} - Agency Agreement - ${parent1Name}`,
      recipients,
      metadata: {
        gostork_provider_id: providerId,
        gostork_parent_user_id: parentUserId,
        gostork_session_id: sessionId,
        gostork_agreement_id: agreement.id,
      },
      tags: ["gostork"],
    };

    const createResponse = await fetch("https://api.pandadoc.com/public/v1/documents", {
      method: "POST",
      headers: {
        "Authorization": `API-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(docBody),
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

    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { pandaDocDocumentId },
    });

    const isReady = await waitForDocumentStatus(apiKey, pandaDocDocumentId, "document.draft");

    if (!isReady) {
      console.warn("[PandaDoc] Template document did not reach draft state");
      await prisma.agreement.update({
        where: { id: agreement.id },
        data: { status: "CREATED" },
      });
      return await prisma.agreement.findUnique({ where: { id: agreement.id } });
    }

    // Send the document.
    const sendResponse = await fetch(`https://api.pandadoc.com/public/v1/documents/${pandaDocDocumentId}/send`, {
      method: "POST",
      headers: {
        "Authorization": `API-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `Hi ${parent1Name}, please review and sign your agreement with ${provider.name}. Once you sign, ${provider.name} will countersign to complete the agreement. If you have any questions, reach out through your GoStork chat.`,
        silent: true,
      }),
    });

    if (!sendResponse.ok) {
      const errorBody = await sendResponse.text();
      console.error("[PandaDoc] Template document send failed:", sendResponse.status, errorBody);
      await prisma.agreement.update({
        where: { id: agreement.id },
        data: { status: "CREATED" },
      });
      return await prisma.agreement.findUnique({ where: { id: agreement.id } });
    }

    // Wait for document to reach "sent" state before creating signing session.
    // PandaDoc's send is async - creating a session before it's SENT gives a view-only link.
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

    return await prisma.agreement.findUnique({ where: { id: agreement.id } });
  } catch (error) {
    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { status: "ERROR" },
    }).catch(() => {});
    throw error;
  }
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
  if (agreement.parentUserId !== userId) throw new Error("Not authorized to access this agreement");
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
