/**
 * All ChatGPT.com DOM selectors live here. When OpenAI ships a UI change,
 * patch this file. Each entry has a primary selector + ordered fallbacks.
 *
 * Verified against chatgpt.com as of April 25, 2026.
 */

export interface SelectorSet {
  /** Composer textarea (#prompt-textarea is a stable ID since at least 2024). */
  composer: string[];
  /** Send/submit button next to the composer. */
  sendButton: string[];
  /** Stop-streaming button (visible only while the model is producing tokens). */
  stopButton: string[];
  /** Model picker / dropdown trigger in the conversation header. */
  modelSwitcher: string[];
  /** Web search composer toggle. */
  webSearchToggle: string[];
  /** Account / profile button — proxy for "logged in" state. */
  accountMenu: string[];
  /** All assistant message bubbles in the current conversation. */
  assistantMessages: string[];
  /** All message bubbles (any role) in the current conversation. */
  anyMessages: string[];
  /** Action bar (copy / regenerate / good / bad) shown on a completed assistant response. */
  assistantActionBar: string[];
  /** Markdown-rendered body inside an assistant bubble. */
  assistantMarkdown: string[];
  /** Conversation history list in the sidebar. */
  conversationList: string[];
  /** Individual conversation item in the sidebar. */
  conversationItem: string[];
  /** New chat / fresh conversation trigger. */
  newChatButton: string[];
  /** File upload input (hidden, used via setInputFiles). */
  fileUpload: string[];
}

export const SELECTORS: SelectorSet = {
  composer: [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="Envoyer"]',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
  ],
  sendButton: [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button:has(svg[data-testid="send-button"])',
    'button[aria-label*="Send"]',
    'button[aria-label*="Envoyer"]',
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Arrêter"]',
    'button:has-text("Stop generating")',
  ],
  modelSwitcher: [
    'button[data-testid="model-switcher-dropdown-button"]',
    'header button[aria-label*="Model selector"]',
    'header button[aria-label*="Sélecteur"]',
    'button[aria-haspopup="menu"]:has(svg)',
  ],
  webSearchToggle: [
    // Current chatgpt.com (April 2026): web search is a menuitemradio
    // inside the "+ Add files and more" composer popover. Has no
    // aria-label, no data-testid — only the inner text.
    '[role="menuitemradio"]:has-text("Web search")',
    '[role="menuitemradio"]:has-text("Recherche web")',
    'div[role="menuitemradio"]:has-text("Web")',
    // Older inline-toggle layouts (kept as fallback)
    'button[data-testid="composer-tool-web-search"]',
    'button[aria-label*="Search the web"]',
    'button[aria-label*="Rechercher sur le web"]',
    'button[aria-label*="web search" i]',
  ],
  accountMenu: [
    'button[data-testid="profile-button"]',
    'button[data-testid="user-menu-button"]',
    'header img[alt*="user"]',
    'nav button:has(img[alt])',
  ],
  assistantMessages: [
    'div[data-message-author-role="assistant"]',
    '[data-message-author-role="assistant"]',
    'main article:has([data-message-author-role="assistant"])',
  ],
  anyMessages: [
    "div[data-message-author-role]",
    "[data-message-author-role]",
    'div[data-testid^="conversation-turn"]',
    "main article",
  ],
  assistantActionBar: [
    'div[role="group"][aria-label*="Actions sur la"]',
    'div[role="group"][aria-label*="Actions on"]',
    'div[role="group"][aria-label*="Actions"]',
  ],
  assistantMarkdown: [
    "div.markdown",
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"]',
  ],
  conversationList: [
    '[data-testid="conversation-list"]',
    'nav[aria-label="Chat history"]',
    'nav[aria-label*="historique" i]',
  ],
  conversationItem: [
    '[data-testid^="history-item-"]',
    '[data-testid="conversation-item"]',
    'nav a[href^="/c/"]',
  ],
  newChatButton: [
    'button[data-testid="create-new-chat-button"]',
    'button[data-testid="new-chat-button"]',
    'a[href="/"]:has(svg)',
  ],
  fileUpload: [
    'input[type="file"][data-testid="file-upload"]',
    'input[type="file"][data-testid="file-upload-button"]',
    'input[type="file"]',
  ],
};

export function joinSelectors(set: string[]): string {
  return set.join(", ");
}
