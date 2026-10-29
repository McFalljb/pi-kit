// Pure helpers for the background shell extension (unit-tested in test/shell-lines.test.ts).

export const MAX_LINE = 300; // characters kept per delivered line
export const MAX_BATCH = 20; // lines per monitor notice; the rest are counted

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** Split a new chunk of output into complete lines; `rest` is the unterminated tail to carry over. */
export function splitLines(carry: string, chunk: string): { lines: string[]; rest: string } {
	const parts = (carry + chunk).split(/\r?\n/);
	const rest = parts.pop() ?? "";
	return { lines: parts, rest };
}

/** Strip terminal escapes and carriage-return redraws, and cap the length. */
export function clip(line: string): string {
	const plain = line.replace(ANSI, "");
	const shown = plain.slice(plain.lastIndexOf("\r") + 1);
	return shown.length > MAX_LINE ? `${shown.slice(0, MAX_LINE)}… [${shown.length - MAX_LINE} more chars]` : shown;
}

/** The last `n` non-empty lines of a text, clipped. */
export function lastLines(text: string, n: number): string[] {
	return text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-n).map(clip);
}

/** Lines for one notice: at most MAX_BATCH, plus a count of the ones left out. */
export function batchText(lines: string[]): string {
	const shown = lines.slice(0, MAX_BATCH);
	const extra = lines.length - shown.length;
	return shown.join("\n") + (extra > 0 ? `\n… ${extra} more matching line${extra === 1 ? "" : "s"} (see the output file)` : "");
}

/** Compile a monitor pattern; undefined means every line. Throws a readable error when invalid. */
export function compilePattern(pattern: string | undefined): RegExp | undefined {
	if (pattern === undefined || pattern === "") return undefined;
	try {
		return new RegExp(pattern);
	} catch (e) {
		throw new Error(`Invalid pattern ${JSON.stringify(pattern)}: ${(e as Error).message}`);
	}
}

export function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
