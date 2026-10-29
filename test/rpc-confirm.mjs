// Drives pi in RPC mode (hasUI = true) to check the guardrail confirm dialog:
// declines the first dangerous command and approves the second.
import { spawn } from "node:child_process";
const prompt = process.argv[2];
const proc = spawn("pi", ["--mode", "rpc", "--no-session"], { stdio: ["pipe", "pipe", "inherit"] });
const answers = [false, true];
const asked = [];
let buf = "";
const timer = setTimeout(() => { console.log("TIMEOUT"); proc.kill(); }, 60_000);
proc.stdout.on("data", (c) => {
	buf += c.toString("utf8");
	const lines = buf.split("\n");
	buf = lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		const ev = JSON.parse(line);
		if (ev.type === "extension_ui_request" && ev.method === "confirm") {
			const confirmed = answers.shift() ?? false;
			asked.push(`${ev.message.split("\n")[0]} => ${confirmed}`);
			proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, confirmed }) + "\n");
		}
		if (ev.type === "agent_settled") {
			console.log(asked.join("\n"));
			clearTimeout(timer);
			proc.kill();
		}
	}
});
proc.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: prompt }) + "\n");
