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

  if (isDocx) {
    // Replace {{TOKEN}} in Word XML directly - avoids PandaDoc reserved keyword conflicts
    const zip = await JSZip.loadAsync(buffer);
    const xmlFiles = ["word/document.xml", "word/header1.xml", "word/header2.xml", "word/footer1.xml", "word/footer2.xml"];
    for (const xmlFile of xmlFiles) {
      if (zip.files[xmlFile]) {
        let content = await zip.files[xmlFile].async("string");
        for (const [name, value] of Object.entries(tokens)) {
          // Replace {{TOKEN}} - also handle cases where Word splits the token across XML runs
          // First, collapse split tokens by removing XML tags between {{ and }}
          content = content.replace(/\{\{([^}]*)\}\}/g, (match: string, inner: string) => {
            // Strip any XML tags inside the token (Word sometimes splits runs)
            const cleanInner = inner.replace(/<[^>]+>/g, "");
            return `{{${cleanInner}}}`;
          });
          content = content.split(`{{${name}}}`).join(value || "");
        }
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
    const res = await fetch(`https://api.pandadoc.com/public/v1/documents/${documentId}/session`, {
      method: "POST",
      headers: {
        "Authorization": `API-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient: recipientEmail, lifetime: 86400 }),
    });
    if (res.ok) {
      const data = await res.json();
      console.log("[PandaDoc] Session created:", JSON.stringify(data));
      return data.id ? `https://app.pandadoc.com/s/${data.id}` : null;
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

  const existingAgreement = await prisma.agreement.findFirst({
    where: { sessionId, providerId, status: { in: ["DRAFT", "SENT"] } },
  });
  if (existingAgreement) throw new Error("An agreement has already been generated for this session");

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
        {
          email: parentEmail,
          first_name: parentUser.firstName || parentName.split(" ")[0] || "",
          last_name: parentUser.lastName || parentName.split(" ").slice(1).join(" ") || "",
          role: "Signer",
          signing_order: 1,
        },
        {
          email: provider.email,
          first_name: provider.name.split(" ")[0] || provider.name,
          last_name: provider.name.split(" ").slice(1).join(" ") || "",
          role: "Provider",
          signing_order: 2,
        },
      ],
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
    const pandaDocDocumentId = pandaDocResult.id;

    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { pandaDocDocumentId },
    });

    // Wait for document to reach draft status
    const isReady = await waitForDocumentStatus(apiKey, pandaDocDocumentId, "document.draft");

    if (!isReady) {
      console.warn("[PandaDoc] Document did not reach draft state, marking as CREATED");
      await prisma.agreement.update({
        where: { id: agreement.id },
        data: { status: "CREATED" },
      });
      return await prisma.agreement.findUnique({ where: { id: agreement.id } });
    }

    // Send the document - requires PandaDoc workspace to allow external recipients
    // (Settings > Security > allow sending outside organization)
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
