import { prisma } from "./db";

interface GenerateAgreementParams {
  providerId: string;
  parentUserId: string;
  sessionId: string;
}

async function waitForDocumentStatus(apiKey: string, documentId: string, targetStatus: string, maxAttempts = 10): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const res = await fetch(`https://api.pandadoc.com/public/v1/documents/${documentId}`, {
      headers: { "Authorization": `API-Key ${apiKey}` },
    });
    if (res.ok) {
      const doc = await res.json();
      if (doc.status === targetStatus) return true;
      if (doc.status === "document.error") return false;
    }
  }
  return false;
}

export async function generateAgreement({ providerId, parentUserId, sessionId }: GenerateAgreementParams) {
  const [provider, parentUser, session] = await Promise.all([
    prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true, name: true, email: true, pandaDocTemplateId: true },
    }),
    prisma.user.findUnique({
      where: { id: parentUserId },
      select: { id: true, name: true, email: true, firstName: true, lastName: true },
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
  if (!provider.pandaDocTemplateId) throw new Error("Provider has no PandaDoc template configured");

  const existingAgreement = await prisma.agreement.findFirst({
    where: { sessionId, providerId, status: { in: ["DRAFT", "SENT"] } },
  });
  if (existingAgreement) throw new Error("An agreement has already been generated for this session");

  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY is not configured");

  const parentName = parentUser.name || `${parentUser.firstName || ""} ${parentUser.lastName || ""}`.trim() || "Intended Parent";
  const parentEmail = parentUser.email;

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
    const payload = {
      name: `${provider.name} - Agency Agreement - ${parentName}`,
      template_uuid: provider.pandaDocTemplateId,
      recipients: [
        {
          email: parentEmail,
          first_name: parentUser.firstName || parentName.split(" ")[0] || "",
          last_name: parentUser.lastName || parentName.split(" ").slice(1).join(" ") || "",
          role: "Client",
        },
      ],
      tokens: [
        { name: "client.name", value: parentName },
        { name: "client.email", value: parentEmail },
        { name: "provider.name", value: provider.name },
        { name: "provider.email", value: provider.email || "" },
      ],
      metadata: {
        gostork_provider_id: providerId,
        gostork_parent_user_id: parentUserId,
        gostork_session_id: sessionId,
        gostork_agreement_id: agreement.id,
      },
    };

    const createResponse = await fetch("https://api.pandadoc.com/public/v1/documents", {
      method: "POST",
      headers: {
        "Authorization": `API-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!createResponse.ok) {
      const errorBody = await createResponse.text();
      console.error("[PandaDoc] Document creation failed:", createResponse.status, errorBody);
      throw new Error(`PandaDoc API error: ${createResponse.status}`);
    }

    const pandaDocResult = await createResponse.json();
    const pandaDocDocumentId = pandaDocResult.id;

    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { pandaDocDocumentId },
    });

    const isReady = await waitForDocumentStatus(apiKey, pandaDocDocumentId, "document.draft");

    if (isReady) {
      const sendResponse = await fetch(`https://api.pandadoc.com/public/v1/documents/${pandaDocDocumentId}/send`, {
        method: "POST",
        headers: {
          "Authorization": `API-Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `Hi ${parentName}, please review and sign your agreement with ${provider.name}. If you have any questions, reach out through your GoStork chat.`,
          silent: false,
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

      await prisma.agreement.update({
        where: { id: agreement.id },
        data: { status: "SENT" },
      });
    } else {
      console.warn("[PandaDoc] Document not ready for sending after polling, marked as CREATED");
      await prisma.agreement.update({
        where: { id: agreement.id },
        data: { status: "CREATED" },
      });
    }

    return await prisma.agreement.findUnique({ where: { id: agreement.id } });
  } catch (error) {
    await prisma.agreement.update({
      where: { id: agreement.id },
      data: { status: "ERROR" },
    }).catch(() => {});
    throw error;
  }
}
