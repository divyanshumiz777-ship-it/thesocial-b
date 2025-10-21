/* eslint-disable unicorn/prefer-string-replace-all */
import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

marked.setOptions({
  breaks: true,
  gfm: true,
});

export function markdownToHtml(markdown: string): string {
  try {
    const html = marked.parse(markdown) as string;
    const sanitized = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "del",
        "code",
        "pre",
        "blockquote",
        "a",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
      ],
      ALLOWED_ATTR: ["href", "title", "target", "rel"],
      ALLOW_DATA_ATTR: false,
    });
    return sanitized;
  } catch (error) {
    console.error("Error converting markdown to HTML:", error);
    return escapeHtml(markdown);
  }
}
// eslint-disable-next-line unicorn/prefer-string-replace-all
export function markdownToPlainText(markdown: string): string {
  let text = markdown;
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/\*(.+?)\*/g, "$1");
  text = text.replace(/__(.+?)__/g, "$1");
  text = text.replace(/~~(.+?)~~/g, "$1");
  text = text.replace(/`(.+?)`/g, "$1");
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/>\s(.+?)$/gm, "$1");
  text = text.replace(/\[(.+?)\]\((.+?)\)/g, "$1");
  text = text.replace(/\n+/g, " ");
  return text.trim();
}

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

export function hasMarkdown(text: string): boolean {
  const markdownPatterns = [
    /\*\*.*?\*\*/,
    /\*.*?\*/,
    /~~.*?~~/,
    /`.*?`/,
    /```[\s\S]*?```/,
    /^>\s/m,
    /\[.*?\]\(.*?\)/,
  ];
  return markdownPatterns.some((pattern) => pattern.test(text));
}
