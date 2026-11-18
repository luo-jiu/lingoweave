import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MiniSentence, MiniWord } from '@lingoweave/contracts';
import { LearningError } from './learning-store.js';

const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    books: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            title: z.string().min(1).max(200),
            url: z.url(),
            fileName: z.string().regex(/^[a-z0-9-]+\.txt$/),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
type Quote = { english: string; source: NonNullable<MiniSentence['source']> };
const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/** A rebuildable local text index. Learning records retain their exact chosen quotation. */
export class MiniMaterialLibrary {
  private readonly quotes: Quote[] = [];
  private readonly byId = new Map<string, Quote>();
  private readonly books: { id: string; title: string; url: string; sha256: string }[] = [];
  private error: string | null = null;

  constructor(directory?: string) {
    if (!directory) return;
    let catalogFound = false;
    try {
      const manifest = join(directory, 'catalog.json');
      if (statSync(manifest).size > 64 * 1024) throw new Error('Invalid material catalog');
      catalogFound = true;
      const catalog = catalogSchema.parse(JSON.parse(readFileSync(manifest, 'utf8')));
      if (new Set(catalog.books.map((book) => book.id)).size !== catalog.books.length)
        throw new Error('Duplicate material identity');
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
      for (const book of catalog.books) {
        const file = join(directory, 'sources', book.fileName);
        if (statSync(file).size > 5 * 1024 * 1024) throw new Error('Material is too large');
        const bytes = readFileSync(file);
        if (digest(bytes) !== book.sha256) throw new Error('Material checksum changed');
        const raw = bytes.toString('utf8');
        const start = /\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i.exec(raw);
        const end = /\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.exec(raw);
        if (!start || !end || end.index <= start.index) throw new Error('Material body is missing');
        const paragraphs = raw
          .slice(start.index + start[0].length, end.index)
          .split(/\r?\n\s*\r?\n/);
        paragraphs.forEach((paragraph, paragraphIndex) => {
          const text = normalize(paragraph);
          for (const part of segmenter.segment(text)) {
            const english = normalize(part.segment);
            const count = english.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g)?.length ?? 0;
            if (count < 4 || count > 18 || /[_*[\]{}<>]/.test(english)) continue;
            if (!/[.!?][”’"']?$/.test(english)) continue;
            if ((english.match(/“/g)?.length ?? 0) !== (english.match(/”/g)?.length ?? 0)) continue;
            const source = {
              id: `quote-${digest(JSON.stringify([book.id, paragraphIndex, english]))}`,
              title: book.title,
              url: book.url,
              locator: `paragraph ${paragraphIndex + 1}`,
            };
            const quote = { english, source };
            this.quotes.push(quote);
            this.byId.set(source.id, quote);
          }
        });
        this.books.push({ id: book.id, title: book.title, url: book.url, sha256: book.sha256 });
      }
    } catch (error) {
      this.quotes.length = 0;
      this.byId.clear();
      this.books.length = 0;
      if (catalogFound || !(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        this.error = '原文素材校验未通过，本次可使用自拟例句。';
    }
  }

  context(words: MiniWord[], level: string) {
    const maximum = level === 'A1' ? 10 : 18;
    return {
      books: this.books,
      error: this.error,
      candidates: words.slice(0, 10).map((word) => {
        const escaped = word.spelling.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matches = new RegExp(
          `(?:^|[^\\p{L}\\p{N}_\\u002d\\u2010\\u2011])${escaped}(?:$|[^\\p{L}\\p{N}_\\u002d\\u2010\\u2011])`,
          'iu',
        );
        const selected = this.quotes
          .filter((quote) => matches.test(quote.english))
          .filter((quote) => (quote.english.match(/[A-Za-z]+/g)?.length ?? 0) <= maximum)
          .sort((left, right) => left.english.length - right.english.length);
        const seen = new Set<string>();
        return {
          word,
          quotes: selected
            .filter((quote) => {
              if (seen.has(quote.english)) return false;
              seen.add(quote.english);
              return true;
            })
            .slice(0, 3),
        };
      }),
    };
  }

  validate(sentence: MiniSentence) {
    if (!sentence.source) return;
    const quote = this.byId.get(sentence.source.id);
    if (
      !quote ||
      quote.english !== normalize(sentence.english) ||
      quote.source.title !== sentence.source.title ||
      quote.source.url !== sentence.source.url ||
      quote.source.locator !== sentence.source.locator
    )
      throw new LearningError('MATERIAL_SOURCE_INVALID', '例句原文或出处与已收录材料不匹配。');
  }
}
