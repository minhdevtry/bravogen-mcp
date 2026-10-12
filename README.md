# BravoGen MCP Server (Bravo 10 ERP Knowledge & AI Assistant)

Máy chủ Model Context Protocol (MCP) chuyên biệt phục vụ các **AI Coding Agents** lập trình, tra cứu và thiết kế trên hệ sinh thái **BRAVO 10 ERP** (Bravo Cloud Native, Linux + PostgreSQL / SQL Server, Docker, Layout XML, Stored Procedures).

Hỗ trợ **đa tài khoản (Multi-Account Pool)** với cơ chế điều phối xoay tua thông minh, tự động chuyển đổi tài khoản khi chạm hạn mức (**Auto-Failover**), tự phục hồi phiên (**Self-Healing Auth**), tự retry và "soi limit". Có thể tự host độc lập (Self-Hosted) dễ dàng qua Docker hoặc Node.js.

---

## 🌟 Tính Năng Nổi Bật

### 1. Đa Tài Khoản & Xoay Tua Hạn Mức Thông Minh (Multi-Account Quota Pool)
- Hỗ trợ khai báo từ **1 đến N tài khoản** nội bộ công ty.
- Chiến lược điều phối **`quota-aware-balanced`**:
  - Ưu tiên tài khoản còn nhiều quota 5 giờ nhất để thực thi.
  - Tự động cân bằng số lượt gọi giữa các tài khoản còn quota.
  - **Auto-Failover**: Nếu tài khoản đang dùng bất ngờ chạm hạn mức (`429 Too Many Requests`), server lập tức xoay sang tài khoản kế tiếp trong pool và thực thi lại ngay lập tức mà AI Agent không bị ngắt quãng.
  - Khi toàn bộ pool đều chạm hạn, server tự động tính toán thời gian reset gần nhất và tự chờ (`auto-wait`) nếu được cấu hình.
- Công cụ `bravogen_pool_status` giám sát tổng dung lượng quota còn lại của toàn bộ pool và trạng thái từng tài khoản.

### 2. Tự Phục Hồi & Tự Retry
- Tự động làm mới JWT Bearer Token qua `/api/auth/refresh`. Khi gặp `401 Unauthorized`, tự động re-login với credentials của từng tài khoản.
- Tự động retry theo Exponential Backoff + Random Jitter khi gặp sự cố mạng hoặc lỗi `502`, `503`, `504`.

### 3. Kho Tri Thức Nội Bộ & Biểu Đồ Sẵn Có
- **56 bảng dữ liệu cốt lõi** (`B00*`, `B10*`, `B30*`).
- **20 Stored Procedures** quan trọng (`usp_B30StockLedger_Costing`, `usp_B30AccDoc_ApprovalVouchers`, `usp_Vcd_InventoryReport`, ...).
- **Quy chuẩn Layout XML**: `BravoEvaluator`, `BravoMoneyEvaluator`, `BravoServerConstraint`, `zSourceReturnMember`, `zDataViewSortExprFormat`, `ColumnChanged`, ...
- **5 Biểu đồ Mermaid có sẵn**: Kiến trúc Bravo Cloud Native, luồng chứng từ Bán hàng & Kho, quy trình tính giá vốn (Moving Average vs Monthly AVG vs FIFO), cơ chế binding XML, quy trình gạch nợ.

---

## 🛠️ Danh Sách 12 Công Cụ (MCP Tools)

| Tên Công Cụ | Tốn Quota? | Mô Tả |
| :--- | :---: | :--- |
| `bravogen_sync_knowledge` | 🟢 **0 Credit** | **Đồng Bộ Tri Thức**: Xuất toàn văn tất cả cuộc hội thoại, mã code và cây suy luận từ server về CSDL offline cục bộ mà không tốn credit. |
| `bravogen_ask_knowledge` | 🟡 **0 hoặc 1** | Hỏi đáp kỹ thuật chuyên sâu qua `bravo-insight` (hỗ trợ `cache_first: true` để trả lời ngay từ kho tri thức với 0 credit). |
| `bravogen_pool_status` | 🟢 **0 Credit** | **Giám sát Pool Đa Tài Khoản**: Xem số tài khoản khỏe mạnh, số tài khoản chạm hạn, tổng lượt gọi còn lại toàn pool. |
| `bravogen_rate_limit_status` | 🟢 **0 Credit** | **Soi Limit**: Xem chi tiết phần trăm quota đã dùng, tokens và requests còn lại, mốc thời gian reset. |
| `bravogen_get_knowledge_diagrams` | 🟢 **0 Credit** | Lấy các biểu đồ kiến trúc hệ thống và quy trình nghiệp vụ Bravo 10 định dạng Mermaid có sẵn. |
| `bravogen_get_procedure_docs` | 🟢 **0 Credit** | Tra cứu cú pháp, vai trò và ngữ cảnh sử dụng của các Stored Procedures (`usp_*`). |
| `bravogen_get_table_schema` | 🟢 **0 Credit** | Tra cứu cấu trúc, vai trò nghiệp vụ và các cột dữ liệu của các bảng Bravo ERP (`B00*`, `B10*`, `B30*`). |
| `bravogen_get_layout_xml_reference` | 🟢 **0 Credit** | Tra cứu quy chuẩn khai báo Layout XML và các Class Evaluator (`BravoEvaluator`, `BravoMoneyEvaluator`, ...). |
| `bravogen_search_knowledge` | 🟢 **0 Credit** | Tìm kiếm toàn văn trong toàn bộ kho tri thức, mã nguồn mẫu, câu lệnh SQL và lịch sử trao đổi. |
| `bravogen_generate_diagram` | 🔴 **1 Credit** | Yêu cầu AI tự động sinh biểu đồ Mermaid mới cho bất kỳ chủ đề hoặc nghiệp vụ Bravo nào theo yêu cầu. |
| `bravogen_list_conversations` | 🟢 **0 Credit** | Liệt kê danh sách các cuộc hội thoại kỹ thuật trên máy chủ BravoGen. |
| `bravogen_get_conversation` | 🟢 **0 Credit** | Lấy toàn bộ nội dung, câu hỏi, câu trả lời và cây suy luận của một cuộc hội thoại cụ thể. |

---

## 💡 Chiến Lược Gọi MCP Không Mất Credit Dành Cho Dev

1. **Đồng bộ tri thức định kỳ (`bravogen_sync_knowledge`)**:
   - Khai thác endpoint `/v1/me/export` trích xuất toàn bộ câu hỏi và câu trả lời chất lượng cao từ giao diện web BravoGen về máy.
   - Thao tác này tiêu tốn **0 credit** và chỉ mất ~1-2 giây.
2. **Sử dụng Cache-First trong `bravogen_ask_knowledge`**:
   - Khi gọi `bravogen_ask_knowledge` với tham số `cache_first: true`, MCP sẽ tìm trong kho tri thức cục bộ trước. Nếu đã có lời giải, kết quả trả về ngay (< 5ms) mà **không gửi request lên server**.
3. **Ưu tiên các công cụ tra cứu offline**:
   - Tra cứu Stored Procedure, bảng dữ liệu, Layout XML qua `bravogen_get_procedure_docs`, `bravogen_get_table_schema`, `bravogen_get_layout_xml_reference` hoàn toàn miễn phí 100%.
4. **Multi-Account Quota Pool**:
   - Cấu hình nhiều tài khoản nội bộ vào `~/.bravogen/accounts.json` để nhân số lượt gọi 5h lên gấp N lần (20 req * N tài khoản).
---

## ⚙️ Hướng Dẫn Cấu Hình Đa Tài Khoản Cho User Tự Host

Hệ thống hỗ trợ 3 cách cấu hình tài khoản (tùy bạn lựa chọn):

### Cách 1: Lưu trữ an toàn ngoài Git tại `~/.bravogen/accounts.json` (Khuyên dùng)
Để tránh vô tình commit mật khẩu vào Git repository, bạn nên tạo file cấu hình tài khoản tại thư mục cá nhân:
`~/.bravogen/accounts.json` (phân quyền `chmod 600`):
```json
[
  {
    "id": "dev_acc_1",
    "username": "your_username",
    "password": "YOUR_PASSWORD_1",
    "baseUrl": "https://chat.bravogen.io.vn"
  },
  {
    "id": "dev_acc_2",
    "username": "user2@bravo.com.vn",
    "password": "YOUR_PASSWORD_2",
    "baseUrl": "https://chat.bravogen.io.vn"
  },
  {
    "id": "dev_acc_3",
    "username": "user3@bravo.com.vn",
    "password": "YOUR_PASSWORD_3",
    "baseUrl": "https://chat.bravogen.io.vn"
  }
]
```

### Cách 2: Sử dụng biến môi trường `BRAVOGEN_ACCOUNTS`
Truyền danh sách tài khoản dạng chuỗi qua biến môi trường:

```bash
# Danh sách user:pass phân cách bằng dấu phẩy
export BRAVOGEN_ACCOUNTS="your_username:Pass1@,user2@bravo.com.vn:Pass2@"

# Hoặc chuỗi JSON
export BRAVOGEN_ACCOUNTS='[{"id":"acc1","username":"u1","password":"p1"},{"id":"acc2","username":"u2","password":"p2"}]'
```

### Cách 3: Tài khoản đơn lẻ (Tương thích ngược)
```bash
export BRAVOGEN_USERNAME="your_username"
export BRAVOGEN_PASSWORD="your_password"
export BRAVOGEN_BASE_URL="https://chat.bravogen.io.vn"
```

---

## 🚀 Các Phương Thức Triển Khai (Self-Hosting)

### Lựa Chọn A: Chạy với Docker / Docker Compose (Nhanh nhất cho Server công ty)
1. Chỉnh sửa thông tin tài khoản trong file `accounts.json`.
2. Khởi động container:
   ```bash
   docker compose up -d
   ```

### Lựa Chọn B: Chạy trực tiếp với Node.js hoặc Bun
```bash
# Cài đặt và build
./setup.sh

# Chạy MCP server
node bin/bravogen-mcp.js
```

### Lựa Chọn C: Cài đặt từ gói nén `npm` (Tarball Package)
Gói phân phối đã được đóng gói sẵn thành file `bravogen-mcp-1.0.0.tgz` (186 KB):
```bash
npm install -g ./bravogen-mcp-1.0.0.tgz
bravogen-mcp
```

---

## 💻 Cấu Hình Client AI (Claude Desktop, Cursor, Pi, Roo Code)

Thêm cấu hình vào file cài đặt MCP của bạn:

```json
{
  "mcpServers": {
    "bravogen": {
      "command": "node",
      "args": [
        "/đường_dẫn_đến_thư_mục/brgen/dist/index.js"
      ],
      "env": {
        "BRAVOGEN_BASE_URL": "https://chat.bravogen.io.vn"
      }
    }
  }
}
```
*(Nếu đã có file `accounts.json` trong thư mục, server sẽ tự động nhận diện toàn bộ tài khoản và kích hoạt chế độ xoay tua).*
