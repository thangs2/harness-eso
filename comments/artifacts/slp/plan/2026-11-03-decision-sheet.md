# Decision sheet — AC-set vs WBS + OPEN debt (2026-11-03)

**Người ký:** A-01 (operator) · **Trạng thái:** chờ ký một lượt · **Bằng chứng:** mỗi mục có `path:line` trong packet/AC.

| id | Câu hỏi | Khuyến nghị | Nếu ký | Nếu không |
|---|---|---|---|---|
| **DS-01** | W1: `2.3`/`2.4`/`2.5` đang mang `AC-ARCH-02/03/04` (= Q1/Q2/Q3) nhưng "Việc" lại là edge-provenance / Q1 / thí nghiệm 5 ticket. Chốt bên nào? | **AC là SoT**: `2.3` = Q1 read set · `2.4` = Q2 column impact · `2.5` = Q3 module cycles. Viết lại "Việc/DoD" của 3 slice + packet `05` thành Q3; edge-provenance ở lại `2.1`; **thí nghiệm 5 ticket** rời WBS — ghi thành debt `T-01` (không AC, không leaf) | WBS khớp AC, `X8a` giữ nguyên; mất 1 leaf "thí nghiệm" (chưa từng có AC) | Giữ "Việc" cũ ⇒ phải tách AC mới cho edge/experiment; `X8a` đỏ vì AC-ARCH-02..04 không còn chủ |
| **DS-02** | `DQ-12` còn nói *"6.7 sở hữu 10 AC-ARCH"* (tiền đề 33 AC cũ) | Sửa `DQ-12`: **6.7 = 16 AC-CFG**, **6.9 = 10 AC-ARCH** theo dictionary `09.deliverable-6` §6.7/§6.9 | Khớp packet 35 đã sửa | Packet 35 đúng, DQ-12 sai — người đọc sau sẽ revert packet |
| **DS-03** | Hai mã `EMPTY_SCOPE`/`DANGLING_SCOPE` (packet 12 nói thiếu) có được thêm vào registry? | **Không thêm**: không `AC` nào nêu tên hai mã này (`AC-AGENT-01-05/-06` chỉ nói "từ chối"); dùng `OUT_OF_SCOPE`/`BAD_REQUEST` đã có. | Registry không phình mã không ai gọi | Phải cấp endpoint/status cho hai mã — không có AC nào biện minh |
| **DS-04** | `REASON_REQUIRED`/`ALREADY_CLOSED`: registry §4 có, contract `API-11` (`12.risk-event.md`) không liệt | Thêm 2 dòng vào bảng lỗi `API-11` (400 · 409), trỏ registry §4 | Contract khớp registry | `X9b`/người đọc contract thấy thiếu mã |
| **DS-05** | `08.OPEN-1` (SCN failure "DB chết giữa lô") + `OPEN-2` (ngưỡng p95) | **Nhận làm debt**: owner `qc`; `OPEN-1` chờ SCN mới, `OPEN-2` chờ `D-36` validate. Không chặn code, **chặn READY** | Packet 08 giữ `OPEN`, không READY | Phải bịa SCN/ngưỡng — cấm |
| **DS-06** | `09.OPEN-5/6` · `11.OPEN-1/3/4` · `12.OPEN-2/3` (SCN/registry/đường đọc) | **Nhận làm debt** với owner đã ghi trong §8; không đóng bằng "cần người" | Trung thực; các packet ở `OPEN` | Đóng ✅ không nguồn = nói dối cổng |
| **DS-07** | `42.OPEN-1` · `43.OPEN-1/2`: mapping `13.open-mapping` ghi ✅ `D-63`, packet vẫn mở | **Packet là SoT**: bỏ ✅ ở mapping, ghi "chưa đóng — packet vẫn mở" | X22/X23 khớp thực tế | Mapping nói dối; X22 xanh giả |

**Sau khi ký:** DS-01 → sửa dictionary + packet 03/04/05; DS-02 → sửa DQ-12; DS-03 → bỏ claim trong packet 12; DS-04 → sửa contract; DS-05/06 → ghi debt vào packet (owner + điều kiện đóng); DS-07 → sửa mapping.

## Kết quả thi hành (2026-11-03)

| id | Trạng thái | Bằng chứng |
|---|---|---|
| DS-01 | ✅ **đã làm** — `D-85` | dictionary W1 §2.3–2.5 + packet `03`/`04`/`05` + `00.index`/`02.wbs-tree`/`01.v2-wbs`; `2.3`/`2.4` = `OPEN` vì thiếu trần fan-out / ngưỡng Q2; `2.5` = `READY` |
| DS-02 | ✅ **đã làm** | `DQ-12` nay: `6.9` sở hữu 10 `AC-ARCH`, `6.7` = 16 `AC-CFG` |
| DS-03 | ✅ **đã ký — `D-88`** | `12 OPEN-2` đóng; hai tên là **giá trị `reason_code`**, không phải mã HTTP |
| DS-04 | ✅ **đã làm** — `D-87` | `12.risk-event.md`: `400 REASON_REQUIRED` · `409 ALREADY_CLOSED` |
| DS-05 | ✅ **đã ký — `D-88`** | `08` `OPEN-1`/`OPEN-2` là debt, owner `qc`; packet giữ `OPEN` |
| DS-06 | ✅ **đã ký — `D-88`** | `09` `OPEN-5/6` · `11` `OPEN-1/3/4` · `12` `OPEN-3/4/5` là debt có chủ |
| DS-07 | ✅ **đã làm** — `D-86` | `13.open-mapping`: `42.OPEN-1` · `43.OPEN-1/2` → *"chưa đóng — packet vẫn mở"* |

**Kiểm:** `bun test` → **744 pass, 0 fail**.
