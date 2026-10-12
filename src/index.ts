import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { AccountPool } from "./pool.js";
import type { KnowledgeDatabase } from "./types.js";

// Load knowledge database (cross-platform resolution)
const packageRoot = typeof import.meta.dirname === "string"
  ? path.resolve(import.meta.dirname, "..")
  : process.cwd();

const candidateKnowledgePaths = [
  path.resolve(packageRoot, "data/bravo_knowledge.json"),
  path.resolve(process.cwd(), "data/bravo_knowledge.json"),
];

const knowledgeDbPath = candidateKnowledgePaths.find((p) => fs.existsSync(p)) || candidateKnowledgePaths[0];
let knowledgeDb: KnowledgeDatabase = {
  version: "1.0.0",
  total_conversations: 0,
  total_tables: 0,
  total_procedures: 0,
  total_xml_tags: 0,
  total_diagrams: 0,
  tables: {},
  procedures: {},
  xml_tags: [],
  diagrams: [],
  conversations: [],
};

if (fs.existsSync(knowledgeDbPath)) {
  try {
    const raw = fs.readFileSync(knowledgeDbPath, "utf-8");
    knowledgeDb = JSON.parse(raw) as KnowledgeDatabase;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MCP] Failed to parse ${knowledgeDbPath}:`, msg);
  }
}

// Initialize Account Pool with auto-discovery
const pool = new AccountPool({
  defaultBaseUrl: process.env.BRAVOGEN_BASE_URL || "https://chat.bravogen.io.vn",
  autoWaitOnRateLimit: true,
  maxWaitSeconds: 90,
});

const configuredAccounts = AccountPool.loadConfig();
for (const acc of configuredAccounts) {
  pool.addAccount(acc);
}

console.error(`[MCP Server] Initialized BravoGen Account Pool with ${pool.getAccountCount()} account(s).`);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const TOOLS = [
  {
    name: "bravogen_ask_knowledge",
    description:
      "Hỏi đáp kỹ thuật chuyên sâu về Bravo 10 ERP, Layout XML, Stored Procedures, hạch toán kế toán, Docker Linux PostgreSQL, ISMS thông qua trợ lý Bravo Insight. Tự phục hồi phiên, tự động xoay tua đa tài khoản khi chạm hạn mức, tự retry, trả về câu trả lời và cây tư duy chi tiết (reasoning).",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Câu hỏi kỹ thuật, đoạn mã XML cần phân tích, hoặc lỗi hệ thống cần tra cứu.",
        },
        model: {
          type: "string",
          enum: ["bravo-insight", "bravo-user-guide", "isms-advisor"],
          default: "bravo-insight",
          description: "Mô hình chuyên môn của BravoGen: bravo-insight (Kỹ thuật/XML/ATTT), bravo-user-guide (Hướng dẫn B10), isms-advisor (ISO 27001).",
        },
        system_prompt: {
          type: "string",
          description: "Chỉ thị bổ sung cho AI (tùy chọn).",
        },
        include_reasoning: {
          type: "boolean",
          default: true,
          description: "Có trả về nội dung suy luận logic từng bước (reasoning_content) không.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "bravogen_pool_status",
    description:
      "Kiểm tra trạng thái của toàn bộ Pool tài khoản: tổng số tài khoản, số tài khoản khỏe mạnh, số tài khoản chạm hạn mức, tổng số lượt gọi còn lại trong 5h và 7d, cùng danh sách chi tiết từng tài khoản.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "bravogen_rate_limit_status",
    description:
      "Soi limit trực tiếp: tính toán phần trăm hạn mức đã dùng, số request và tokens còn lại trong chu kỳ 5 giờ và 7 ngày của tài khoản đang hoạt động tốt nhất và tổng quan toàn pool.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "bravogen_get_knowledge_diagrams",
    description:
      "Lấy các biểu đồ knowledge graph, kiến trúc hệ thống và sơ đồ quy trình nghiệp vụ Bravo 10 định dạng Mermaid có sẵn để phục vụ AI coding agents.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["all", "architecture", "costing", "layout_xml", "sales", "debt_offset"],
          default: "all",
          description: "Phân loại biểu đồ cần lấy.",
        },
        query: {
          type: "string",
          description: "Từ khóa tìm kiếm trong tiêu đề hoặc nội dung biểu đồ.",
        },
      },
    },
  },
  {
    name: "bravogen_get_procedure_docs",
    description:
      "Tra cứu thông tin, vai trò nghiệp vụ và các đoạn code ngữ cảnh của các thủ tục Stored Procedures cốt lõi trong Bravo 10 (usp_*).",
    inputSchema: {
      type: "object",
      properties: {
        procedure_name: {
          type: "string",
          description: "Tên thủ tục (ví dụ: usp_B30StockLedger_Costing, usp_B30AccDoc_ApprovalVouchers, usp_Vcd_InventoryReport, usp_sys_MergeCode, ...). Để trống để lấy toàn bộ danh mục.",
        },
      },
    },
  },
  {
    name: "bravogen_get_table_schema",
    description:
      "Tra cứu vai trò, ý nghĩa các trường dữ liệu và bối cảnh sử dụng của các bảng dữ liệu Bravo ERP (B00*, B10*, B30*).",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Tên bảng dữ liệu (ví dụ: B30StockLedger, B30AccDoc, B00FieldList, B00UserList, B00DMCT, ...). Để trống để lấy toàn bộ danh mục.",
        },
      },
    },
  },
  {
    name: "bravogen_get_layout_xml_reference",
    description:
      "Tra cứu tài liệu và quy chuẩn khai báo Layout XML, các thẻ Evaluator (BravoEvaluator, BravoMoneyEvaluator, BravoServerConstraint, zSourceReturnMember, zDataViewSortExprFormat, ...).",
    inputSchema: {
      type: "object",
      properties: {
        tag_or_class: {
          type: "string",
          description: "Tên thẻ hoặc Class XML cần tra cứu (ví dụ: BravoMoneyEvaluator, zSourceReturnMember, ColumnChanged, BravoUniqueKeyValidator).",
        },
      },
    },
  },
  {
    name: "bravogen_search_knowledge",
    description:
      "Tìm kiếm toàn văn trong kho giải pháp, cấu hình XML, SQL thủ tục, và lịch sử trao đổi nội bộ BravoGen.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Từ khóa tìm kiếm (ví dụ: 'giá vốn', 'Linux', 'zSourceReturnMember', 'ColumnChanged', 'gạch nợ').",
        },
        limit: {
          type: "number",
          default: 5,
          description: "Số lượng kết quả tối đa trả về.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "bravogen_generate_diagram",
    description:
      "Yêu cầu Bravo Insight tự động vẽ biểu đồ Mermaid (Flowchart, Sequence hoặc ER Diagram) cho bất kỳ quy trình nghiệp vụ hoặc cấu trúc dữ liệu Bravo nào theo yêu cầu.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Chủ đề hoặc quy trình cần vẽ sơ đồ (ví dụ: 'Quy trình duyệt chứng từ nhiều cấp', 'Luồng dữ liệu tính giá vốn FIFO').",
        },
        diagram_type: {
          type: "string",
          enum: ["flowchart", "sequence", "er_diagram", "class_diagram"],
          default: "flowchart",
          description: "Kiểu biểu đồ Mermaid mong muốn.",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "bravogen_list_conversations",
    description:
      "Liệt kê danh sách các cuộc hội thoại kỹ thuật hiện có trên server BravoGen.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          default: 15,
          description: "Số cuộc hội thoại tối đa cần lấy.",
        },
      },
    },
  },
  {
    name: "bravogen_get_conversation",
    description:
      "Lấy chi tiết toàn bộ lịch sử hỏi đáp, đoạn code mẫu và suy luận trong một cuộc hội thoại theo conversation_id.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          description: "ID cuộc hội thoại.",
        },
      },
      required: ["conversation_id"],
    },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "bravogen_ask_knowledge": {
      const question = String(args.question || "");
      const model = String(args.model || "bravo-insight");
      const systemPrompt = args.system_prompt ? String(args.system_prompt) : undefined;
      const includeReasoning = args.include_reasoning !== false;

      const res = await pool.chatCompletion(question, {
        model,
        systemPrompt,
      });

      if (res.error) {
        return `[LỖI BRAVOGEN] ${res.error}`;
      }

      let out = "";
      if (res.rateLimitSummary) {
        out += `${res.rateLimitSummary}\n\n`;
      }
      if (includeReasoning && res.reasoning) {
        out += `### Suy Luận Kỹ Thuật (Reasoning):\n${res.reasoning}\n\n---\n\n`;
      }
      out += `### Trả Lời (${res.model}):\n${res.answer}`;
      return out;
    }

    case "bravogen_pool_status": {
      const overview = await pool.getPoolOverview();
      const rows = overview.accounts.map(
        (a) =>
          `| ${a.id} | ${a.username} | ${a.status === "healthy" ? "🟢 Khỏe mạnh" : "🔴 Chạm hạn"} | ${a.remaining5hRequests}/20 | ${a.remaining7dRequests}/300 | ${a.resetsAt5h ? a.resetsAt5h.slice(11, 19) : "N/A"} | ${a.totalCalls} |`
      );

      return [
        `# Báo Cáo Trạng Thái Account Pool BravoGen`,
        `- Tổng số tài khoản: **${overview.totalAccounts}**`,
        `- Tài khoản sẵn sàng (Healthy): **${overview.healthyAccounts}**`,
        `- Tài khoản đang chạm hạn mức (Throttled): **${overview.throttledAccounts}**`,
        `- Tổng lượt gọi 5h còn lại toàn pool: **${overview.total5hRequestsRemaining} requests**`,
        `- Tổng lượt gọi 7d còn lại toàn pool: **${overview.total7dRequestsRemaining} requests**`,
        `- Chiến lược điều phối: **${overview.strategy}** (Ưu tiên tài khoản còn nhiều quota nhất, cân bằng tải tự động)`,
        "",
        `| ID | Tài khoản | Trạng thái | Quota 5h | Quota 7d | Reset 5h | Đã gọi |`,
        `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`,
        ...rows,
      ].join("\n");
    }

    case "bravogen_rate_limit_status": {
      const overview = await pool.getPoolOverview();
      const activeClient = await pool.getActiveClient();
      const status = await activeClient.getRateLimitStatus();

      if (!status) {
        return "Không thể kết nối hoặc lấy trạng thái hạn mức từ server BravoGen.";
      }

      const c = status.computed;
      const w5h = status.windows.find((w) => w.name === "5h");
      const w7d = status.windows.find((w) => w.name === "7d");

      return [
        `# Báo Cáo Hạn Mức BravoGen API (Tài khoản hiện tại: ${status.userId})`,
        `- Trạng thái: ${status.enabled ? "Hoạt động bình thường" : "Bị khóa"}`,
        `- Tình trạng Throttled: ${c?.isThrottled ? "CẢNH BÁO: Hết hạn mức!" : "Bình thường (Còn hạn mức)"}`,
        "",
        `## Chu Kỳ 5 Giờ (5h Window):`,
        `- Requests: ${w5h?.requests ?? 0} / ${w5h?.requestLimit ?? 20} (Đã dùng: ${c?.pct5hRequestsUsed ?? 0}%, Còn lại: ${c?.remaining5hRequests ?? 0})`,
        `- Tokens: ${(w5h?.tokens ?? 0).toLocaleString()} / ${(w5h?.tokenLimit ?? 1500000).toLocaleString()} (Còn lại: ${(c?.remaining5hTokens ?? 0).toLocaleString()})`,
        `- Thời điểm Reset: ${w5h?.resetsAt || "N/A"}`,
        "",
        `## Chu Kỳ 7 Ngày (7d Window):`,
        `- Requests: ${w7d?.requests ?? 0} / ${w7d?.requestLimit ?? 300} (Đã dùng: ${c?.pct7dRequestsUsed ?? 0}%, Còn lại: ${c?.remaining7dRequests ?? 0})`,
        `- Tokens: ${(w7d?.tokens ?? 0).toLocaleString()} / ${(w7d?.tokenLimit ?? 20000000).toLocaleString()} (Còn lại: ${(c?.remaining7dTokens ?? 0).toLocaleString()})`,
        `- Thời điểm Reset: ${w7d?.resetsAt || "N/A"}`,
        "",
        `## Tổng Quan Account Pool:`,
        `- Tổng số tài khoản trong Pool: ${overview.totalAccounts} (Sẵn sàng: ${overview.healthyAccounts}, Hết hạn: ${overview.throttledAccounts})`,
        `- Tổng Quota 5h còn lại toàn Pool: ${overview.total5hRequestsRemaining} requests`,
      ].join("\n");
    }

    case "bravogen_get_knowledge_diagrams": {
      const category = String(args.category || "all");
      const query = args.query ? String(args.query).toLowerCase() : "";

      let list = knowledgeDb.diagrams;
      if (category !== "all") {
        list = list.filter((d) => d.id.includes(category) || d.title.toLowerCase().includes(category));
      }
      if (query) {
        list = list.filter(
          (d) => d.title.toLowerCase().includes(query) || d.code.toLowerCase().includes(query)
        );
      }

      if (list.length === 0) {
        return `Không tìm thấy biểu đồ nào phù hợp với bộ lọc (category: ${category}, query: ${query}).`;
      }

      return list
        .map(
          (d, idx) =>
            `### Biểu Đồ ${idx + 1}: ${d.title} (ID: ${d.id})\n*Nguồn: ${d.source_conversation}*\n\n\`\`\`mermaid\n${d.code}\n\`\`\``
        )
        .join("\n\n---\n\n");
    }

    case "bravogen_get_procedure_docs": {
      const procName = args.procedure_name ? String(args.procedure_name).trim() : "";
      if (!procName) {
        const names = Object.keys(knowledgeDb.procedures).sort();
        return [
          `# Danh Mục Stored Procedures Bravo 10 (${names.length} thủ tục):`,
          ...names.map((n) => `- **${n}** (Số lần đề cập: ${knowledgeDb.procedures[n].mentions})`),
        ].join("\n");
      }

      const match = knowledgeDb.procedures[procName];
      if (!match) {
        const candidates = Object.keys(knowledgeDb.procedures).filter((k) =>
          k.toLowerCase().includes(procName.toLowerCase())
        );
        if (candidates.length > 0) {
          return [
            `Không tìm thấy chính xác '${procName}'. Các thủ tục tương tự:`,
            ...candidates.map((c) => `- **${c}**`),
          ].join("\n");
        }
        return `Không tìm thấy thủ tục '${procName}' trong kho tri thức nội bộ. Bạn có thể dùng công cụ 'bravogen_ask_knowledge' để truy vấn trực tiếp mô hình AI.`;
      }

      return [
        `# Tài Liệu Thủ Tục: ${match.name}`,
        `- Tần suất xuất hiện: ${match.mentions} lần`,
        `- Ngữ cảnh & Cách sử dụng trong Bravo 10:`,
        ...match.contexts.map((ctx, idx) => `> **Trích đoạn ${idx + 1}:** ${ctx}...`),
      ].join("\n\n");
    }

    case "bravogen_get_table_schema": {
      const tableName = args.table_name ? String(args.table_name).trim() : "";
      if (!tableName) {
        const names = Object.keys(knowledgeDb.tables).sort();
        return [
          `# Danh Mục Bảng Dữ Liệu Bravo ERP (${names.length} bảng):`,
          ...names.map((n) => `- **${n}** (Số lần đề cập: ${knowledgeDb.tables[n].mentions})`),
        ].join("\n");
      }

      const match = knowledgeDb.tables[tableName];
      if (!match) {
        const candidates = Object.keys(knowledgeDb.tables).filter((k) =>
          k.toLowerCase().includes(tableName.toLowerCase())
        );
        if (candidates.length > 0) {
          return [
            `Không tìm thấy chính xác '${tableName}'. Các bảng tương tự:`,
            ...candidates.map((c) => `- **${c}**`),
          ].join("\n");
        }
        return `Không tìm thấy bảng '${tableName}' trong kho tri thức. Bạn có thể dùng 'bravogen_ask_knowledge' để hỏi trợ lý Bravo Insight.`;
      }

      return [
        `# Bảng Dữ Liệu: ${match.name}`,
        `- Tần suất xuất hiện: ${match.mentions} lần`,
        `- Ngữ cảnh nghiệp vụ & các cột thường dùng:`,
        ...match.contexts.map((ctx, idx) => `> **Trích đoạn ${idx + 1}:** ${ctx}...`),
      ].join("\n\n");
    }

    case "bravogen_get_layout_xml_reference": {
      const tag = args.tag_or_class ? String(args.tag_or_class).trim().toLowerCase() : "";
      const tags = knowledgeDb.xml_tags;

      if (!tag) {
        return [
          `# Quy Chuẩn Khai Báo Layout XML Bravo 10:`,
          `Hệ thống ghi nhận ${tags.length} thẻ XML và Class Evaluator thông dụng.`,
          `Các Class quan trọng nhất:`,
          `- **BravoEvaluator**: Xử lý tính toán công thức tổng quát, ẩn hiện điều khiển, kiểm tra biểu thức logic.`,
          `- **BravoMoneyEvaluator**: Xử lý tính toán tiền tệ và làm tròn số thập phân tự động (zResultDecimalRound).`,
          `- **BravoServerConstraint**: Ràng buộc dữ liệu qua Stored Procedure hoặc CommandKey, ánh xạ cột trả về qua zSourceReturnMember.`,
          `- **BravoUniqueKeyValidator**: Kiểm tra tính duy nhất trên các dòng lưới chi tiết (ngăn trùng ItemId).`,
          `- **BravoLinkCommand**: Liên kết lấy dữ liệu giữa các chứng từ (VD: Đơn hàng sang Hóa đơn).`,
          "",
          `Ví dụ các thẻ cấu hình tiêu biểu:`,
          tags.slice(0, 40).map((t) => `\`<${t}>\``).join(", "),
        ].join("\n");
      }

      const matches = tags.filter((t) => t.toLowerCase().includes(tag));
      return [
        `# Kết Quả Tra Cứu Thẻ XML cho '${tag}':`,
        matches.length > 0
          ? matches.map((m) => `- \`<${m}>\``).join("\n")
          : `Không tìm thấy thẻ có tên '${tag}'.`,
        "",
        `Để tra cứu chi tiết cách dùng của thẻ này trong mã nguồn thực tế, bạn có thể gọi 'bravogen_search_knowledge' hoặc 'bravogen_ask_knowledge'.`,
      ].join("\n");
    }

    case "bravogen_search_knowledge": {
      const q = String(args.query || "").toLowerCase();
      const limit = Number(args.limit) || 5;

      const results: string[] = [];

      for (const conv of knowledgeDb.conversations) {
        for (const msg of conv.messages) {
          if (msg.text.toLowerCase().includes(q)) {
            const preview = msg.text.slice(0, 350).replace(/\n+/g, " ");
            results.push(
              `### [${conv.title}] (${msg.role} - ${msg.created_at.slice(0, 10)}):\n> ${preview}...\n`
            );
            if (results.length >= limit) break;
          }
        }
        if (results.length >= limit) break;
      }

      if (results.length === 0) {
        const client = await pool.getActiveClient();
        const serverRes = await client.searchConversations(q);
        if (serverRes.length > 0) {
          return [
            `Tìm thấy ${serverRes.length} cuộc hội thoại liên quan trên server:`,
            ...serverRes.map((r) => `- **${r.title}** (ID: ${r.id}, cập nhật: ${r.updated_at})`),
          ].join("\n");
        }
        return `Không tìm thấy kết quả nào cho '${q}'.`;
      }

      return [`# Kết Quả Tìm Kiếm Tri Thức Nội Bộ cho '${q}':`, ...results].join("\n\n");
    }

    case "bravogen_generate_diagram": {
      const topic = String(args.topic || "");
      const diagramType = String(args.diagram_type || "flowchart");

      const prompt = [
        `Hãy thiết kế một biểu đồ Mermaid chuẩn (loại: ${diagramType}) mô tả chi tiết cho chủ đề sau trong hệ thống BRAVO 10:`,
        `Chủ đề: "${topic}"`,
        `Yêu cầu:`,
        `1. Biểu đồ phải thể hiện chính xác các thực thể, bảng dữ liệu (B00/B10/B30), thủ tục stored procedure (nếu có), hoặc luồng người dùng/hệ thống.`,
        `2. Đặt toàn bộ biểu đồ trong một khối \`\`\`mermaid duy nhất, cú pháp hợp lệ 100%.`,
        `3. Kèm theo phần giải thích ngắn gọn bằng tiếng Việt bên dưới.`,
      ].join("\n");

      const res = await pool.chatCompletion(prompt, {
        model: "bravo-insight",
      });

      if (res.error) {
        return `[LỖI TẠO BIỂU ĐỒ] ${res.error}`;
      }

      return res.answer;
    }

    case "bravogen_list_conversations": {
      const limit = Number(args.limit) || 15;
      const client = await pool.getActiveClient();
      const convs = await client.listConversations(limit);
      if (convs.length === 0) {
        return "Không có cuộc hội thoại nào hoặc không thể lấy danh sách từ server.";
      }

      return [
        `# Danh Sách Cuộc Hội Thoại Trên BravoGen (${convs.length} mục):`,
        ...convs.map(
          (c, idx) =>
            `${idx + 1}. **${c.title}**\n   - ID: \`${c.id}\`\n   - Model: ${c.model || "bravo-insight"}\n   - Cập nhật: ${c.updated_at}`
        ),
      ].join("\n");
    }

    case "bravogen_get_conversation": {
      const cid = String(args.conversation_id || "");
      const client = await pool.getActiveClient();
      const conv = await client.getConversation(cid);
      if (!conv) {
        return `Không tìm thấy cuộc hội thoại với ID: ${cid}`;
      }

      const msgs = conv.messages || [];
      return [
        `# Chi Tiết Hội Thoại: ${conv.title} (ID: ${conv.id})`,
        `- Tổng số tin nhắn: ${msgs.length}`,
        "",
        ...msgs.map(
          (m, idx) =>
            `### [Tin nhắn ${idx + 1}] Role: ${m.role.toUpperCase()} (${m.created_at})\n${m.reasoning ? `*Suy luận:*\n> ${m.reasoning.slice(0, 300)}...\n\n` : ""}${m.text || ""}`
        ),
      ].join("\n\n---\n\n");
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// JSON-RPC stdio handler
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    const errorResp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32700, message: "Parse error" },
    };
    process.stdout.write(JSON.stringify(errorResp) + "\n");
    return;
  }

  const { id, method, params } = req;

  try {
    switch (method) {
      case "initialize": {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: {
              name: "bravogen-mcp",
              version: "1.0.0",
            },
          },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
        break;
      }

      case "notifications/initialized": {
        break;
      }

      case "tools/list": {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
        break;
      }

      case "tools/call": {
        const toolName = String(params?.name || "");
        const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
        const textResult = await handleToolCall(toolName, toolArgs);

        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: textResult,
              },
            ],
          },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
        break;
      }

      case "resources/list": {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            resources: [
              {
                uri: "bravo://diagrams",
                name: "Bravo Knowledge Graph & Mermaid Diagrams",
                mimeType: "application/json",
              },
              {
                uri: "bravo://procedures",
                name: "Bravo Stored Procedures Reference",
                mimeType: "application/json",
              },
              {
                uri: "bravo://tables",
                name: "Bravo Database Tables Catalog",
                mimeType: "application/json",
              },
            ],
          },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
        break;
      }

      case "resources/read": {
        const uri = String(params?.uri || "");
        let textContent = "";

        if (uri === "bravo://diagrams") {
          textContent = JSON.stringify(knowledgeDb.diagrams, null, 2);
        } else if (uri === "bravo://procedures") {
          textContent = JSON.stringify(knowledgeDb.procedures, null, 2);
        } else if (uri === "bravo://tables") {
          textContent = JSON.stringify(knowledgeDb.tables, null, 2);
        } else {
          const resp: JsonRpcResponse = {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Resource not found: ${uri}` },
          };
          process.stdout.write(JSON.stringify(resp) + "\n");
          return;
        }

        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: textContent,
              },
            ],
          },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
        break;
      }

      default: {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
        process.stdout.write(JSON.stringify(resp) + "\n");
        break;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const resp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Internal error: ${msg}` },
    };
    process.stdout.write(JSON.stringify(resp) + "\n");
  }
});
