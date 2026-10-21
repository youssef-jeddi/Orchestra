// ─── Telegram — pause commands (ORC-39) ───
// /pause stops a wallet's automatic actions at once (it only takes power away, so the linked chat
// is enough). /resume doesn't turn them back on from the chat: it answers with a link to Orchestra,
// where Resume needs the owner's passkey, like raising a limit, so someone holding only the phone
// or the Telegram account can't give the agent its power back. /status says what is on.
// /pauseall and /resumeall switch automatic actions off and on for everyone, from the chats listed
// in ADMIN_CHAT_IDS only. Pure apart from the deps, so it's tested without Telegram.

import type { PauseStatus } from "../../policy/killSwitch";

export interface CommandReply {
  text: string;
  button?: { text: string; url: string };
}

export interface CommandDeps {
  isAdminChat(chatId: number): boolean;
  /** Pause the wallet; `changed` is false when it already was. Throws when it couldn't be saved. */
  pauseWallet(wallet: string): Promise<{ changed: boolean }>;
  status(wallet: string): Promise<PauseStatus>;
  /** Is the global switch on (or unreadable)? */
  globalPaused(): boolean;
  setGlobal(on: boolean): Promise<void>;
  /** The page where Resume is pressed, or null without a public app address. */
  resumeLink(): string | null;
}

export const COMMANDS = ["/pause", "/resume", "/status", "/pauseall", "/resumeall"] as const;

const NOT_LINKED = "This chat isn't linked to a wallet. Open Orchestra and press \"Link Telegram\" first.";
const PAUSED_TEXT =
  "⏸ Automatic actions are paused. From now on I'll ask for your OK before every payment, swap or liquidity change.\n" +
  "Send /resume to turn them back on.";
const GLOBAL_TEXT = "Orchestra has paused automatic actions for everyone right now. You can still approve each request; they come back on when the team turns them on.";

/** "/pause@OrchestraBot now" → "/pause". */
export function commandOf(text: string): string {
  return text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
}

/** The reply to a command, or null when it isn't one of these (the chat ignores it, as before). */
export async function runCommand(text: string, chatId: number, wallet: string | null, deps: CommandDeps): Promise<CommandReply | null> {
  const cmd = commandOf(text);
  if (!(COMMANDS as readonly string[]).includes(cmd)) return null;

  if (cmd === "/pauseall" || cmd === "/resumeall") {
    if (!deps.isAdminChat(chatId)) return { text: "This command isn't available in this chat." };
    const on = cmd === "/pauseall";
    try {
      await deps.setGlobal(on);
    } catch {
      return {
        text: on
          ? "⏸ Automatic actions are paused for everyone on this server, but I couldn't save it, so a restart would undo it. Try /pauseall again in a moment."
          : "I couldn't save the switch, so automatic actions stay paused for everyone. Try /resumeall again in a moment.",
      };
    }
    return {
      text: on
        ? "⏸ Automatic actions are paused for everyone. Every payment, swap or liquidity change now needs its owner's OK. Send /resumeall to turn them back on."
        : "▶️ Automatic actions are back on for everyone. An account that paused itself stays paused.",
    };
  }

  if (!wallet) return { text: NOT_LINKED };

  if (cmd === "/pause") {
    try {
      const { changed } = await deps.pauseWallet(wallet);
      return { text: changed ? PAUSED_TEXT : `Automatic actions were already paused.\nSend /resume to turn them back on.` };
    } catch {
      return { text: "⏸ Automatic actions are paused for now, but I couldn't save it, so a restart of Orchestra would undo it. Send /pause again in a moment." };
    }
  }

  let status: PauseStatus;
  try {
    status = await deps.status(wallet);
  } catch {
    status = { wallet: false, global: deps.globalPaused(), unreadable: true, other: false };
  }

  if (cmd === "/resume") {
    if (!status.wallet && !status.unreadable) {
      return { text: status.global ? GLOBAL_TEXT : "Automatic actions are on. There's nothing to resume." };
    }
    const link = deps.resumeLink();
    const text = "To turn automatic actions back on, open Orchestra and press Resume. It asks for your passkey, so nobody with only this chat can turn them back on." +
      (status.global ? `\n\n${GLOBAL_TEXT}` : "");
    return link ? { text, button: { text: "Open Orchestra", url: link } } : { text };
  }

  // /status
  const lines: string[] = [];
  if (status.unreadable) lines.push("I can't check right now whether automatic actions are paused, so I'm treating them as paused: everything needs your OK.");
  else if (status.wallet) lines.push("⏸ You paused automatic actions: everything needs your OK. Send /resume to turn them back on.");
  else if (!status.global && !status.other) lines.push("▶️ Automatic actions are on: small payments within your limits run on their own. Send /pause to stop them.");
  if (status.global && !status.unreadable) lines.push(`⏸ ${GLOBAL_TEXT}`);
  if (status.other) lines.push("⏸ I couldn't save the record of your last automatic payment, so I'm asking before the next one until it's saved.");
  return { text: lines.join("\n\n") };
}

/** The page that opens the Limits sheet with Resume, from PUBLIC_APP_URL, or null without one. */
export function resumeLink(publicAppUrl = process.env.PUBLIC_APP_URL): string | null {
  if (!publicAppUrl) return null;
  try {
    return `${new URL(publicAppUrl).origin}/simple?resume=1`;
  } catch {
    return null;
  }
}
