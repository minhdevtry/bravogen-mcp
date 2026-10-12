# HƯỚNG DẪN TỰ ĐỘNG CÀI ĐẶT & KÍCH HOẠT DÀNH CHO AI AGENT (RUNBOOK)

> **Dành cho người dùng:** Copy toàn bộ nội dung khối code bên dưới và gửi trực tiếp cho AI Coding Agent của bạn (Cursor Agent, Claude Code, Roo Code, Windsurf, Aider...). Agent sẽ tự động nhận diện hệ điều hành, cài đặt, đăng ký MCP server và hướng dẫn bạn reload để dùng được ngay lập tức!

---

```markdown
Bạn là chuyên gia tự động hóa cài đặt hệ thống. Nhiệm vụ của bạn là thiết lập và kích hoạt hoàn tất máy chủ BravoGen MCP (`bravogen-mcp`) vào môi trường của tôi. Hãy thực hiện tuần tự và chính xác các bước sau:

### Bước 1: Kiểm tra môi trường Node.js
- Kiểm tra xem máy tính đã cài đặt Node.js phiên bản >= 18 chưa (`node -v`).
- Nếu chưa có Node.js, hãy dừng lại và thông báo tôi tải cài đặt từ https://nodejs.org.

### Bước 2: Cài đặt gói BravoGen MCP toàn cục
Chạy lệnh sau tại thư mục của dự án để đăng ký lệnh `bravogen-mcp` vào hệ thống:
```bash
npm install -g ./bravogen-mcp-1.0.0.tgz
```
*(Nếu môi trường của tôi không cho phép cài đặt toàn cục, hãy sử dụng trực tiếp file đã build sẵn `dist/index.js` qua lệnh `node <ĐƯỜNG_DẪN_TUYỆT_ĐỐI_ĐẾN_DIST_INDEX_JS>`).*

### Bước 3: Cấu hình tài khoản người dùng
1. Để bảo mật và tránh vô tình commit mật khẩu vào Git repository, ghi thông tin tài khoản trực tiếp vào file cá nhân `~/.bravogen/accounts.json` (hoặc `accounts.json` trong thư mục dự án):
2. Cấu trúc nội dung file:
```json
[
  {
    "id": "acc_primary",
    "username": "TÊN_TÀI_KHOẢN_CỦA_TÔI",
    "password": "MẬT_KHẨU_CỦA_TÔI",
    "baseUrl": "https://chat.bravogen.io.vn"
  }
]
```

### Bước 4: Tự động đăng ký vào Claude Desktop hoặc Cursor
Hãy tìm file cấu hình MCP của tôi theo hệ điều hành hiện tại:
- **Claude Desktop trên Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Claude Desktop trên macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop trên Linux:** `~/.config/Claude/claude_desktop_config.json`
- **Cursor MCP toàn cục:** `~/.cursor/mcp.json` (hoặc `.cursor/mcp.json` trong project hiện tại).

Đọc file cấu hình hiện có (nếu chưa có thì tạo mới) và merge thêm khối `bravogen` vào mục `mcpServers`:
```json
{
  "mcpServers": {
    "bravogen": {
      "command": "bravogen-mcp"
    }
  }
}
```

### Bước 5: Kiểm tra và Hướng dẫn tôi Reload để dùng ngay
1. Chạy thử lệnh `bravogen-mcp` (hoặc `node dist/index.js < /dev/null`) để xác nhận máy chủ khởi động bình thường không gặp lỗi cú pháp.
2. **Quan trọng nhất:** Sau khi ghi file cấu hình xong, hãy thông báo rõ ràng cho tôi:
   - **Nếu dùng Cursor:** Nhấn `Ctrl + Shift + P` (hoặc `Cmd + Shift + P` trên Mac) -> gõ `Developer: Reload Window` để Cursor nạp lại MCP server.
   - **Nếu dùng Claude Desktop:** Tắt hoàn toàn ứng dụng Claude Desktop và mở lại.
3. Cung cấp cho tôi 3 câu hỏi mẫu để tôi thử nghiệm ngay sau khi reload:
   - *"Kiểm tra trạng thái hạn mức và số lượt gọi còn lại của các tài khoản trong pool."*
   - *"Tra cứu thủ tục Stored Procedure usp_B30StockLedger_Costing trong Bravo 10."*
   - *"Lấy biểu đồ Mermaid kiến trúc hệ thống phân tầng của Bravo Cloud Native."*
```
