// Scripted OpenAI-compatible chat-completions server for offline smoke tests.
// A user message containing lines `@@ {"name":"tool","arguments":{...}}` is played as a sequence of
// tool calls (one per assistant turn); then the mock answers "FINAL: <last tool result>".
// Each request is logged as one JSON line: model, every tool result so far, every shell notice so
// far, the last message, the reply. Shell notices are answered "GOT SHELL: <first line>".
// Each request's system prompt goes to <log>.system as one JSON line.
// "$ID" in arguments is replaced by the last pi-subagents run id ("<agent> [<id>]") seen in tool results,
// "$OUT" by the last shell output file ("Output: <path>.log").
import http from "node:http";
import fs from "node:fs";
const port = Number(process.argv[2] || 18555);
const log = process.argv[3] || "/dev/null";
// Notices from the kit's shell extension (bash_bg exits, monitor batches, wake_later timers).
const SHELL_NOTICE = /^(?:(?:Background shell|Monitor) sh|Wake-up wk)\d+/;
// The kit's notes reminder: context, not a new request, so the mock keeps playing the user's steps.
const REMINDER = /^Context is [\d.]+% full and will be compacted soon/;
const textOf = (c) => (typeof c === "string" ? c : (c || []).map((p) => p.text || "").join(""));

// pi-subagents 0.84 wraps its completion notice in a <pi_subagents_notice> envelope; match the status line.
const reportOf = (t) => (/@@/.test(t) ? null : t.match(/^Background task (?:completed|failed).*$/m));

function decide(messages) {
	const isUser = (m, skipReports) => m.role === "user" && !REMINDER.test(textOf(m.content)) && !(skipReports && reportOf(textOf(m.content)));
	const lastIndex = (skipReports) => messages.findLastIndex((m) => isUser(m, skipReports));
	// A completion notice can arrive mid-turn (pi delivers it as a steer while the parent is still
	// running, e.g. right after bg_wait). It must not abandon the steps of the prompt in progress.
	const stepsAt = (i) => textOf(messages[i]?.content).split("\n").filter((l) => l.startsWith("@@ ")).map((l) => JSON.parse(l.slice(3)));
	const doneAfter = (i) => messages.slice(i + 1).filter((m) => m.role === "assistant").length;
	const prompt = lastIndex(true);
	const pending = prompt >= 0 && doneAfter(prompt) < stepsAt(prompt).length;
	const lastUser = pending ? prompt : lastIndex(false);
	const userText = textOf(messages[lastUser]?.content);
	const report = reportOf(userText);
	if (report) return { text: `GOT REPORT: ${report[0]}` };
	if (SHELL_NOTICE.test(userText) && !/@@/.test(userText)) return { text: `GOT SHELL: ${userText.split("\n")[0]}` };
	const steps = stepsAt(lastUser);
	const done = doneAfter(lastUser);
	const toolTexts = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
	const ids = [...toolTexts.join("\n").matchAll(/(?:Async|Run): \S+ \[([0-9a-f-]{8,})\]/g)].map((m) => m[1]);
	const id = ids.length ? ids[ids.length - 1] : "none";
	const outs = [...toolTexts.join("\n").matchAll(/Output: (\S+\.log)/g)].map((m) => m[1]);
	const out = outs.length ? outs[outs.length - 1] : "none";
	if (done < steps.length) {
		const s = JSON.parse(JSON.stringify(steps[done]).replaceAll("$ID", id).replaceAll("$OUT", out));
		return { tool: s };
	}
	return { text: `FINAL: ${(toolTexts[toolTexts.length - 1] || "no tools").slice(0, 600)}` };
}

http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const j = JSON.parse(body || "{}");
		const msgs = j.messages || [];
		const d = decide(msgs);
		if (log !== "/dev/null") fs.appendFileSync(`${log}.system`, JSON.stringify({ model: j.model, system: msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n") }) + "\n");
		fs.appendFileSync(log, JSON.stringify({ model: j.model, tools: msgs.filter((m) => m.role === "tool").map((m) => textOf(m.content).slice(0, 120)), notices: msgs.filter((m) => m.role === "user" && SHELL_NOTICE.test(textOf(m.content))).map((m) => textOf(m.content).slice(0, 2000)), reminders: msgs.filter((m) => m.role === "user" && REMINDER.test(textOf(m.content))).map((m) => textOf(m.content).slice(0, 60)), last: msgs.slice(-1).map((m) => ({ role: m.role, text: textOf(m.content).slice(0, 300) })), out: d }) + "\n");
		const base = { id: "mock", object: "chat.completion.chunk", created: 0, model: j.model };
		const chunk = (delta, finish = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (d.tool) {
			res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: d.tool.name, arguments: JSON.stringify(d.tool.arguments) } }] }));
			res.write(chunk({}, "tool_calls"));
		} else {
			res.write(chunk({ role: "assistant", content: d.text }));
			res.write(chunk({}, "stop"));
		}
		res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
}).listen(port, "127.0.0.1");
