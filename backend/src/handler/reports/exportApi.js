const { ddbDocClient, TABLE_NAME } = require("../../shared/database");
const { extractIdentity, verifyOrigin } = require("../../shared/auth");
const { error, cors } = require("../../shared/response");
const { QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const ExcelJS = require("exceljs");

exports.handler = async (event) => {
    try {
        // CORS pre-flight
        if (event.requestContext?.http?.method === "OPTIONS") {
            return cors();
        }

        // CloudFront origin verification
        if (!verifyOrigin(event)) {
            return {
                statusCode: 403,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Yêu cầu bị từ chối: Chỉ chấp nhận các kết nối đi qua CloudFront." })
            };
        }

        // Extract identity from JWT claims
        const identity = extractIdentity(event);
        if (!identity || !identity.tenantId || !identity.userId) {
            return {
                statusCode: 401,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Yêu cầu không hợp lệ: Yêu cầu phải được xác thực." })
            };
        }

        const { tenantId, userId, role } = identity;
        
        // Extract parameters from path and query
        const pathParameters = event.pathParameters || {};
        const yearMonth = pathParameters.yearMonth; // e.g. "2026-07"
        
        const queryParams = event.queryStringParameters || {};
        const targetEmployeeId = queryParams.userId; // optional target user ID

        if (!yearMonth) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Thiếu thông tin tháng báo cáo cần xuất (yearMonth)!" })
            };
        }

        // Get all user records under this tenant
        const result = await ddbDocClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
            ExpressionAttributeValues: {
                ":pk": `TENANT#${tenantId}`,
                ":sk_prefix": "USER#"
            }
        }));

        let monthlyRecords = (result.Items || []).filter(item => item.SK.includes(`#ATTENDANCE#${yearMonth}`));

        // Enforce role-based security boundaries for reports
        if (role === "EMPLOYEE") {
            // Employees can only export their own records
            monthlyRecords = monthlyRecords.filter(item => item.UserId === userId);
        } else if (role === "MANAGER") {
            // Manager cannot export Admin reports (filter out all ADMIN metadata records first)
            const adminUsersList = (result.Items || [])
                .filter(item => item.SK.endsWith("#METADATA") && item.Role === "ADMIN")
                .map(item => item.SK.split("#")[1]);

            monthlyRecords = monthlyRecords.filter(item => !adminUsersList.includes(item.UserId));

            if (targetEmployeeId && targetEmployeeId !== "ALL") {
                monthlyRecords = monthlyRecords.filter(item => item.UserId === targetEmployeeId);
            }
        } else if (role === "ADMIN") {
            if (targetEmployeeId && targetEmployeeId !== "ALL") {
                monthlyRecords = monthlyRecords.filter(item => item.UserId === targetEmployeeId);
            }
        }

        // Build the Excel workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet(`Báo Cáo ${yearMonth}`);

        worksheet.columns = [
            { header: "Mã Nhân Viên", key: "userId", width: 18 },
            { header: "Thời Gian Chấm", key: "timestamp", width: 25 },
            { header: "Loại Ca Ghi Nhận", key: "action", width: 18 },
            { header: "Hình Thức Xác Thực", key: "device", width: 20 },
            { header: "Trạng Thái", key: "status", width: 15 }
        ];

        monthlyRecords.forEach(item => {
            worksheet.addRow({
                userId: item.UserId,
                timestamp: new Date(item.Timestamp).toLocaleString("vi-VN"),
                action: item.Action === "CHECKIN" ? "Vào Ca (CHECKIN)" : "Ra Ca (CHECKOUT)",
                device: item.DeviceVerified,
                status: item.Status
            });
        });

        // Write workbook to buffer
        const buffer = await workbook.xlsx.writeBuffer();

        // Return base64 encoded binary data
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename=BaoCao_ChamCong_${yearMonth}.xlsx`,
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type,Authorization"
            },
            body: buffer.toString("base64"),
            isBase64Encoded: true
        };
    } catch (err) {
        console.error("Lỗi xuất báo cáo hệ thống:", err);
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ message: "Lỗi xuất báo cáo hệ thống: " + err.message })
        };
    }
};
