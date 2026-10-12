import { spawn } from "node:child_process";
import * as path from "node:path";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string; version: string };
    tools?: Array<{ name: string; description: string }>;
    content?: Array<{ type: string; text: string }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

async function runMcpTest() {
  console.log("=== Starting BravoGen Multi-Account MCP Smoke Test ===");

  const serverPath =
    typeof import.meta.dirname === "string"
      ? path.resolve(import.meta.dirname, "../dist/index.js")
      : path.resolve(process.cwd(), "dist/index.js");

  const serverProcess = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });

  let currentId = 1;
  const pendingRequests = new Map<number, (res: JsonRpcResponse) => void>();

  let buffer = "";
  serverProcess.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line) as JsonRpcResponse;
        const cb = pendingRequests.get(resp.id);
        if (cb) {
          pendingRequests.delete(resp.id);
          cb(resp);
        }
      } catch (err: unknown) {
        console.error("Failed to parse response:", line, err);
      }
    }
  });

  function callRpc(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = currentId++;
    const { promise, resolve } = Promise.withResolvers<JsonRpcResponse>();
    pendingRequests.set(id, resolve);
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    serverProcess.stdin.write(req);
    return promise;
  }

  // 1. Initialize
  console.log("\n[Test 1] Testing initialize...");
  const initRes = await callRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  console.log("Server Info:", initRes.result?.serverInfo);

  // 2. List tools
  console.log("\n[Test 2] Testing tools/list...");
  const toolsRes = await callRpc("tools/list");
  const toolNames = toolsRes.result?.tools?.map((t) => t.name) || [];
  console.log(`Registered ${toolNames.length} tools:`, toolNames.join(", "));

  // 3. Test bravogen_pool_status (Multi-Account Pool inspection)
  console.log("\n[Test 3] Testing bravogen_pool_status (Multi-Account Pool Monitor)...");
  const poolRes = await callRpc("tools/call", {
    name: "bravogen_pool_status",
    arguments: {},
  });
  console.log(poolRes.result?.content?.[0]?.text);

  // 4. Test bravogen_rate_limit_status ("soi limit")
  console.log("\n[Test 4] Testing bravogen_rate_limit_status ('soi limit')...");
  const limitRes = await callRpc("tools/call", {
    name: "bravogen_rate_limit_status",
    arguments: {},
  });
  console.log(limitRes.result?.content?.[0]?.text);

  // 5. Test bravogen_get_knowledge_diagrams
  console.log("\n[Test 5] Testing bravogen_get_knowledge_diagrams...");
  const diagRes = await callRpc("tools/call", {
    name: "bravogen_get_knowledge_diagrams",
    arguments: { category: "all" },
  });
  const diagText = diagRes.result?.content?.[0]?.text || "";
  console.log(`Retrieved diagrams output length: ${diagText.length} chars`);

  // 6. Test bravogen_get_procedure_docs
  console.log("\n[Test 6] Testing bravogen_get_procedure_docs (usp_B30StockLedger_Costing)...");
  const procRes = await callRpc("tools/call", {
    name: "bravogen_get_procedure_docs",
    arguments: { procedure_name: "usp_B30StockLedger_Costing" },
  });
  console.log(procRes.result?.content?.[0]?.text);

  // 7. Test bravogen_get_table_schema
  console.log("\n[Test 7] Testing bravogen_get_table_schema (B30StockLedger)...");
  const tableRes = await callRpc("tools/call", {
    name: "bravogen_get_table_schema",
    arguments: { table_name: "B30StockLedger" },
  });
  console.log(tableRes.result?.content?.[0]?.text);

  // 8. Test bravogen_get_layout_xml_reference
  console.log("\n[Test 8] Testing bravogen_get_layout_xml_reference (BravoMoneyEvaluator)...");
  const xmlRes = await callRpc("tools/call", {
    name: "bravogen_get_layout_xml_reference",
    arguments: { tag_or_class: "BravoMoneyEvaluator" },
  });
  console.log(xmlRes.result?.content?.[0]?.text);

  // 9. Test bravogen_search_knowledge
  console.log("\n[Test 9] Testing bravogen_search_knowledge ('giá vốn')...");
  const searchRes = await callRpc("tools/call", {
    name: "bravogen_search_knowledge",
    arguments: { query: "giá vốn", limit: 2 },
  });
  console.log(searchRes.result?.content?.[0]?.text);

  const isFast = process.argv.includes("--fast");
  if (isFast) {
    serverProcess.kill();
    console.log("\n=== Fast Smoke Test Passed Successfully! (~0.5s, không tốn quota 5h) ===");
    console.log("(Để test cả luồng AI trực tiếp, hãy chạy: node test/smoke_test.ts --full hoặc ./test-ket-noi.sh --full)");
    return;
  }

  // 10. Test bravogen_ask_knowledge (live AI query with smart pool rotation)
  console.log("\n[Test 10] Testing bravogen_ask_knowledge with live AI pool execution...");
  const askRes = await callRpc("tools/call", {
    name: "bravogen_ask_knowledge",
    arguments: {
      question: "Trong Bravo 10, Stored Procedure usp_B30StockLedger_Costing thực hiện những nhiệm vụ chính nào? Trả lời thật ngắn gọn 2 gạch đầu dòng.",
      model: "bravo-insight",
      include_reasoning: false,
    },
  });
  console.log(askRes.result?.content?.[0]?.text);

  serverProcess.kill();
  console.log("\n=== All Multi-Account Smoke Tests Passed Successfully! ===");
}
runMcpTest().catch((err: unknown) => {
  console.error("Test failed:", err);
  process.exit(1);
});
