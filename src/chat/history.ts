export class PromptHistory {
  readonly #entries: string[] = [];
  readonly #maxEntries: number;
  #index = 0;
  #draft = "";

  constructor(maxEntries = 100) {
    this.#maxEntries = maxEntries;
  }

  begin(): void {
    this.#index = this.#entries.length;
    this.#draft = "";
  }

  previous(current: string): string | null {
    if (this.#entries.length === 0 || this.#index === 0) return null;
    if (this.#index === this.#entries.length) this.#draft = current;
    this.#index--;
    return this.#entries[this.#index];
  }

  next(): string | null {
    if (this.#index === this.#entries.length) return null;
    this.#index++;
    return this.#index === this.#entries.length
      ? this.#draft
      : this.#entries[this.#index];
  }

  record(text: string): void {
    if (!text || this.#entries.at(-1) === text) return;
    this.#entries.push(text);
    if (this.#entries.length > this.#maxEntries) this.#entries.shift();
    this.begin();
  }
}
