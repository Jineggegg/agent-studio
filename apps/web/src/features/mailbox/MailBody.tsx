/** Mail is literal text, including any HTML or Markdown supplied by the sender. */
export function MailBody({ text }: { text: string }) {
  return <div className="mail-body">{text}</div>;
}
