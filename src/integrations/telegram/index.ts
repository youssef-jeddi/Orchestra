// ─── Telegram — out-of-band approvals ───
// A bot that shows a risky action on the user's phone, decoded from the exact
// payload the server will execute, with Approve / Reject buttons. A hacked
// browser can't change what the phone shows or press the phone's buttons.
//
// Linking a chat to a wallet requires an EIP-712 signature from that wallet
// (see linkRequest / confirmLink), so nobody can point someone else's
// approvals at their own Telegram. Updates arrive by long polling, so no public
// webhook URL is needed. Disabled unless TELEGRAM_BOT_TOKEN is set.

import crypto from "crypto";
import { ethers } from "ethers";
import { read, write, deleteKey } from "../zero-g/storage";

const API = "https://api.telegram.org";
const LINK_TTL_MS = 10 * 60_000;
const CHAIN_ID = 11155111;

export function telegramEnabled(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

async function call<T = any>(method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

let botUsername: string | null = null;
async function getBotUsername(): Promise<string> {
  botUsername ??= (await call<{ username: string }>("getMe")).username;
  return botUsername;
}

// ── Wallet ↔ chat links (persisted) ──

export interface TelegramLink {
  chatId: number;
  username?: string;
  linkedAt: string;
}

export async function getLink(wallet: string): Promise<TelegramLink | null> {
  try {
    return ((await read(`telegram:${wallet.toLowerCase()}`)) as TelegramLink | null) ?? null;
  } catch {
    return null;
  }
}

async function walletForChat(chatId: number): Promise<string | null> {
  try {
    return ((await read(`telegram-chat:${chatId}`)) as { wallet: string } | null)?.wallet ?? null;
  } catch {
    return null;
  }
}

async function unlinkChat(chatId: number): Promise<string | null> {
  const wallet = await walletForChat(chatId);
  if (wallet) await deleteKey(`telegram:${wallet}`).catch(() => {});
  await deleteKey(`telegram-chat:${chatId}`).catch(() => {});
  return wallet;
}

// ── Linking: wallet signs a one-time code, then /start <code> in Telegram ──

interface LinkCode {
  wallet: string;
  expires: number;
  /** Set once the wallet signature checked out. */
  verified: boolean;
}
const linkCodes = new Map<string, LinkCode>();

function linkTypedData(wallet: string, code: string) {
  return {
    domain: { name: "Orchestra", version: "1", chainId: CHAIN_ID },
    types: {
      TelegramLink: [
        { name: "wallet", type: "address" },
        { name: "code", type: "string" },
        { name: "purpose", type: "string" },
      ],
    },
    primaryType: "TelegramLink" as const,
    message: {
      wallet: ethers.getAddress(wallet),
      code,
      purpose: "Send my Orchestra transaction approvals to the Telegram chat that opens this code.",
    },
  };
}

/** Step 1: typed data for the wallet to sign (EIP712Domain included for eth_signTypedData_v4). */
export function linkRequest(wallet: string) {
  if (!ethers.isAddress(wallet)) throw new Error("invalid wallet address");
  const code = crypto.randomBytes(12).toString("base64url");
  linkCodes.set(code, { wallet: wallet.toLowerCase(), expires: Date.now() + LINK_TTL_MS, verified: false });
  const td = linkTypedData(wallet, code);
  return {
    code,
    typedData: {
      ...td,
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        ...td.types,
      },
    },
  };
}

/** Step 2: verify the wallet's signature over the code; returns the t.me deep link. */
export async function confirmLink(wallet: string, code: string, signature: string): Promise<{ url: string }> {
  const entry = linkCodes.get(code);
  if (!entry || entry.expires < Date.now() || entry.wallet !== wallet.toLowerCase()) {
    throw new Error("Link request expired. Start again.");
  }
  const td = linkTypedData(wallet, code);
  const signer = ethers.verifyTypedData(td.domain, td.types, td.message, signature);
  if (signer.toLowerCase() !== entry.wallet) throw new Error("Signature doesn't match this wallet.");
  entry.verified = true;
  return { url: `https://t.me/${await getBotUsername()}?start=${code}` };
}

async function completeLink(code: string, chatId: number, username?: string): Promise<string | null> {
  const entry = linkCodes.get(code);
  linkCodes.delete(code); // single-use
  if (!entry || !entry.verified || entry.expires < Date.now()) return null;
  await unlinkChat(chatId); // one wallet per chat
  const previous = await getLink(entry.wallet);
  if (previous) await deleteKey(`telegram-chat:${previous.chatId}`).catch(() => {});
  await write(`telegram:${entry.wallet}`, { chatId, username, linkedAt: new Date().toISOString() } satisfies TelegramLink);
  await write(`telegram-chat:${chatId}`, { wallet: entry.wallet });
  return entry.wallet;
}

// ── Messages ──

/**
 * Send an approval request. With `reviewUrl` (phone-passkey mode) there is no
 * Approve button: approving happens on the review page, with the phone's passkey.
 */
export async function sendApprovalMessage(chatId: number, approvalId: string, html: string, reviewUrl?: string): Promise<number> {
  const reject = { text: "✖️ Reject", callback_data: `r:${approvalId}` };
  const msg = await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: reviewUrl
        ? [[{ text: "🔐 Review & approve", url: reviewUrl }], [reject]]
        : [[{ text: "✅ Approve", callback_data: `a:${approvalId}` }, reject]],
    },
  });
  return msg.message_id;
}

/** A plain message with one link button (e.g. the phone passkey setup link). */
export async function sendLinkMessage(chatId: number, text: string, buttonText: string, url: string): Promise<void> {
  await call("sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: buttonText, url }]] },
  });
}

export async function sendText(chatId: number, text: string): Promise<void> {
  await call("sendMessage", { chat_id: chatId, text });
}

/** Replace the buttons with the outcome, keeping the original description above it. */
export async function settleApprovalMessage(chatId: number, messageId: number, originalHtml: string, outcomeHtml: string): Promise<void> {
  await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `${originalHtml}\n\n${outcomeHtml}`,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  }).catch((err) => console.warn(`[telegram] edit failed: ${err.message}`));
}

// ── Update loop ──

export interface DecisionHandler {
  /** Approve or reject approval `approvalId` for the wallet linked to this chat. Returns a short toast. */
  (input: { wallet: string; approvalId: string; approve: boolean; chatId: number; messageId: number }): Promise<string>;
}

async function handleUpdate(update: any, onDecision: DecisionHandler): Promise<void> {
  if (update.message?.text) {
    const chatId: number = update.message.chat.id;
    const text: string = update.message.text.trim();
    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1];
      const wallet = code ? await completeLink(code, chatId, update.message.from?.username) : null;
      await call("sendMessage", {
        chat_id: chatId,
        text: wallet
          ? `✅ Linked to wallet ${wallet}.\nRisky Orchestra transactions will now ask for your approval here. Send /unlink to stop.`
          : "Open Orchestra, connect your wallet and press \"Link Telegram\" to get a link for this chat.",
      });
      return;
    }
    if (text === "/unlink") {
      const wallet = await unlinkChat(chatId);
      await call("sendMessage", { chat_id: chatId, text: wallet ? `Unlinked from ${wallet}.` : "This chat isn't linked to a wallet." });
      return;
    }
    return;
  }

  const cb = update.callback_query;
  if (cb?.data && cb.message) {
    const [kind, approvalId] = String(cb.data).split(":");
    const chatId: number = cb.message.chat.id;
    // The chat pressing the button must be the one linked to a wallet; the handler checks it owns the approval.
    const wallet = await walletForChat(chatId);
    let toast = "This chat isn't linked to a wallet.";
    if (wallet && (kind === "a" || kind === "r") && approvalId) {
      toast = await onDecision({ wallet, approvalId, approve: kind === "a", chatId, messageId: cb.message.message_id })
        .catch((err: any) => err.message as string);
    }
    await call("answerCallbackQuery", { callback_query_id: cb.id, text: toast.slice(0, 190) }).catch(() => {});
  }
}

let polling = false;

/** Start long polling (idempotent). Logs and retries on errors; never throws. */
export async function startTelegramBot(onDecision: DecisionHandler): Promise<void> {
  if (!telegramEnabled() || polling) return;
  polling = true;
  try {
    await call("deleteWebhook", { drop_pending_updates: false });
    console.log(`[telegram] bot @${await getBotUsername()} polling for updates`);
  } catch (err: any) {
    console.error(`[telegram] startup failed: ${err.message}`);
  }

  let offset = 0;
  (async () => {
    while (polling) {
      try {
        const updates = await call<any[]>("getUpdates", {
          offset, timeout: 25, allowed_updates: ["message", "callback_query"],
        }, 35_000);
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u, onDecision).catch((err) => console.error(`[telegram] update error: ${err.message}`));
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") console.warn(`[telegram] polling error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  })();
}
