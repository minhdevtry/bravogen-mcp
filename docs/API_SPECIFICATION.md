# BravoGen Chat API Reverse Engineering Specification

**Target**: `https://chat.bravogen.io.vn`  
**Identity Provider**: LDAP / Bravo Internal Identity Server (`Microsoft-IIS/10.0`, ASP.NET Core)  
**Token Format**: JWT Bearer (`HS256`, 15-minute expiration) + UUID Refresh Token  

---

## 1. Authentication Flow

### 1.1 Login (`POST /api/auth/login`)
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "username": "your_username",
    "password": "..."
  }
  ```
- **Response** (`200 OK`):
  ```json
  {
    "access_token": "eyJhbGciOiJIUzI1NiIsIn...",
    "refresh_token": "emA6686YD4mos8bcdfutxorVQV9Nta3d9vFmijt8Wi4",
    "user": {
      "id": "your_username@bravo.com.vn",
      "name": "Lê Trần Đại Nghĩa - your_username",
      "email": "your_username@bravo.com.vn",
      "provider": "ldap",
      "is_admin": false,
      "role": "prouser"
    }
  }
  ```

### 1.2 Token Refresh (`POST /api/auth/refresh`)
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "refresh_token": "emA6686YD4mos8bcdfutxorVQV9Nta3d9vFmijt8Wi4"
  }
  ```
- **Response** (`200 OK`):
  ```json
  {
    "access_token": "eyJhbGci...",
    "refresh_token": "new_refresh_token_if_rotated"
  }
  ```

### 1.3 User Profile (`GET /api/auth/me`)
- **Headers**: `Authorization: Bearer <access_token>`
- Returns user identity, email, admin flag, and role.

---

## 2. Models & Rate Limits

### 2.1 Models (`GET /v1/models`)
- Returns available models in OpenAI list format:
  1. `bravo-insight`: "Hỗ trợ kỹ thuật về nền tảng, khai báo Layout XML, chính sách nội bộ và tư vấn tuân thủ ATTT" (Context: 200,000, Max output: 65,536).
  2. `bravo-user-guide`: "Hướng dẫn sử dụng phần mềm Bravo 10" (Context: 200,000, Max output: 65,536).
  3. `isms-advisor`: "Hỗ trợ triển khai và vận hành ISMS theo ISO/IEC 27001" (Context: 200,000, Max output: 65,536).

### 2.2 Rate Limit Status (`GET /v1/rate_limit/status`)
- Returns live quotas across two rolling windows:
  ```json
  {
    "userId": "your_username@bravo.com.vn",
    "enabled": true,
    "windows": [
      {
        "name": "5h",
        "tokens": 23501,
        "tokenLimit": 1500000,
        "requests": 2,
        "requestLimit": 20,
        "resetsAt": "2026-10-12T07:52:22.932116+00:00"
      },
      {
        "name": "7d",
        "tokens": 1335459,
        "tokenLimit": 20000000,
        "requests": 21,
        "requestLimit": 300,
        "resetsAt": "2026-10-15T00:00:00+00:00"
      }
    ]
  }
  ```

---

## 3. Chat Completions (`POST /v1/chat/completions`)

### 3.1 Request Payload
```json
{
  "model": "bravo-insight",
  "messages": [
    {
      "role": "user",
      "content": "Giải thích cấu hình thẻ zSourceReturnMember trong Layout XML"
    }
  ],
  "stream": false,
  "conversation_id": "optional-uuid",
  "parent_message_id": "optional-uuid",
  "user_message_client_id": "uuid",
  "assistant_message_client_id": "uuid"
}
```

### 3.2 Non-streaming Response (`200 OK`)
```json
{
  "id": "chatcmpl-45cbb2806a3a47f38457cc215545976f",
  "object": "chat.completion",
  "created": 1791773553,
  "model": "bravo-insight",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Nội dung trả lời...",
        "reasoning_content": "Suy luận chi tiết..."
      }
    }
  ]
}
```

### 3.3 Streaming Response (`stream: true`)
- Standard SSE format (`data: { ... }`) ending with `data: [DONE]`.
- Chunks include `delta.content` and `delta.reasoning_content`.

---

## 4. Conversation History & Search

- `GET /v1/conversations`: List recent conversation threads.
- `GET /v1/conversations/{id}`: Full message tree including all assistant reasoning, timestamps, errors.
- `GET /v1/conversations/search?q={keyword}`: Server-side search across historical conversations.
- `PATCH /v1/conversations/{id}`: Rename title or set pinned status.
- `DELETE /v1/conversations/{id}`: Delete conversation.

---

## 5. File Uploads

- `POST /v1/files`: Multipart form-data with field `file` (up to 50MB).
- Returns uploaded file metadata `{ url, name, mime_type, size }`.
