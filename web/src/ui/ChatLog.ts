/**
 * The conversation as text: what the user said (typed or transcribed) and what Kamari said,
 * oldest at the top, plus the conversation's token count after each turn.
 */
export class ChatLog {
  private pending: HTMLElement | null = null; // "…" while the user is still talking
  private reply: { li: HTMLElement; text: HTMLElement } | null = null; // Kamari's answer to the last message

  constructor(
    private readonly list: HTMLElement,
    private readonly total: HTMLElement,
  ) {}

  /** The user started talking: a placeholder until the transcript arrives. */
  listening(): void {
    if (!this.pending) this.pending = this.add('you', '…');
  }

  /** What the user said; also ends Kamari's previous answer. */
  user(text: string): void {
    const li = this.pending ?? this.add('you', '');
    li.querySelector('.text')!.textContent = text || '(nothing heard)';
    li.classList.toggle('empty', !text);
    this.pending = null;
    this.reply = null;
    this.scroll();
  }

  /** A sentence Kamari speaks; sentences of one answer share a bubble. */
  kamari(sentence: string): void {
    if (!this.reply) {
      const li = this.add('kamari', '');
      this.reply = { li, text: li.querySelector('.text')! };
    }
    this.reply.li.classList.remove('quiet');
    const t = this.reply.text;
    if (t.textContent?.endsWith(sentence)) return; // a resent chunk
    t.textContent = t.textContent ? `${t.textContent} ${sentence}` : sentence;
    this.scroll();
  }

  /** Tokens after a turn: the turn's own under its answer, the running total in the header. */
  usage(u: { input_tokens?: number; output_tokens?: number; total_input_tokens?: number; total_output_tokens?: number }): void {
    const totals = `${fmt(u.total_input_tokens)} in · ${fmt(u.total_output_tokens)} out`;
    this.total.textContent = `${totals} tokens`;
    this.total.title = 'LLM tokens this conversation has used so far';
    const note = document.createElement('small');
    note.className = 'usage';
    note.textContent = `Total ${totals} tokens · this turn ${fmt(u.input_tokens)} in · ${fmt(u.output_tokens)} out`;
    if (this.reply) this.reply.li.append(note);
    else {
      // No spoken answer (yet): the note stands on its own, and later sentences of the turn go above it.
      const li = this.add('kamari', '');
      li.classList.add('quiet');
      li.append(note);
      this.reply = { li, text: li.querySelector('.text')! };
    }
    this.scroll();
  }

  private add(who: 'you' | 'kamari', text: string): HTMLElement {
    const li = document.createElement('li');
    li.className = who;
    const name = document.createElement('b');
    name.textContent = who === 'you' ? 'You' : 'Kamari';
    const span = document.createElement('span');
    span.className = 'text';
    span.textContent = text;
    li.append(name, span);
    this.list.append(li);
    while (this.list.children.length > 200) this.list.firstElementChild!.remove();
    this.scroll();
    return li;
  }

  private scroll(): void {
    this.list.scrollTop = this.list.scrollHeight;
  }
}

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString('en-US');
