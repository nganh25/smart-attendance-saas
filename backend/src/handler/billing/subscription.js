const { ddbDocClient, TABLE_NAME } = require("../../shared/database");
const { extractIdentity, verifyOrigin } = require("../../shared/auth");
const { success, error, cors } = require("../../shared/response");
const { PutCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { PayOS } = require("@payos/node");

const payos = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID || "dummy_client_id_123456789",
    apiKey: process.env.PAYOS_API_KEY || "dummy_api_key_123456789",
    checksumKey: process.env.PAYOS_CHECKSUM_KEY || "dummy_checksum_key_123456789"
});

exports.handler = async (event) => {
    try {
        // CORS pre-flight
        if (event.requestContext?.http?.method === "OPTIONS") {
            return cors();
        }

        // CloudFront origin verification
        if (!verifyOrigin(event)) {
            return error(403, "Yêu cầu bị từ chối: Chỉ chấp nhận các kết nối đi qua CloudFront.");
        }

        // Extract identity from JWT claims
        const identity = extractIdentity(event);
        if (!identity || !identity.tenantId || !identity.userId) {
            return error(401, "Yêu cầu không hợp lệ: Yêu cầu phải được xác thực.");
        }

        const { tenantId, role } = identity;
        const method = event.requestContext?.http?.method || "POST";

        // Only ADMIN can query/update subscription
        if (role !== "ADMIN") {
            return error(403, "Quyền hạn không hợp lệ! Chỉ quản trị viên cấp cao mới có quyền quản lý gói cước.");
        }

        // ─── GET: Check current subscription status ───
        if (method === "GET") {
            const result = await ddbDocClient.send(new GetCommand({
                TableName: TABLE_NAME,
                Key: {
                    PK: `TENANT#${tenantId}`,
                    SK: "SUBSCRIPTION#CURRENT"
                }
            }));

            const subscription = result.Item || {
                plan: "FREE",
                status: "ACTIVE",
                maxUsers: 5,
                expiresAt: null
            };

            return success(200, { subscription });
        }

        // ─── POST: Create payment link ───
        if (method === "POST") {
            const body = JSON.parse(event.body || "{}");
            const { amount, packageName } = body;

            if (!amount || !packageName) {
                return error(400, "Thiếu thông tin gói dịch vụ (amount, packageName)!");
            }

            const orderCode = Number(String(Date.now()).slice(-6));
            const timestamp = new Date().toISOString();

            // Check if we are using mock credentials
            const isMock = !process.env.PAYOS_CLIENT_ID || process.env.PAYOS_CLIENT_ID === "dummy_client_id_123456789";

            if (isMock) {
                // Save mock billing record
                await ddbDocClient.send(new PutCommand({
                    TableName: TABLE_NAME,
                    Item: {
                        PK: `TENANT#${tenantId}`,
                        SK: `BILLING#ORDER#${orderCode}`,
                        Amount: amount,
                        Package: packageName,
                        Status: "PENDING",
                        CreatedAt: timestamp
                    }
                }));

                const apiGatewayUrl = event.headers?.Host || event.headers?.host || "localhost:3000";
                const scheme = apiGatewayUrl.includes("execute-api") ? "https" : "http";
                const webhookUrl = `${scheme}://${apiGatewayUrl}/billing/webhook?mock=true&tenantId=${tenantId}&orderCode=${orderCode}&status=PAID`;

                return success(200, {
                    message: "Đã tạo đơn hàng thanh toán (chế độ mô phỏng)!",
                    orderCode,
                    checkoutUrl: webhookUrl,
                    status: "PENDING"
                });
            }

            // Real PayOS flow
            const origin = event.headers?.origin || event.headers?.Origin || "http://localhost:5173";
            const paymentData = {
                orderCode: orderCode,
                amount: amount,
                description: `Gia han ${packageName}`,
                cancelUrl: `${origin}?payment=cancel`,
                returnUrl: `${origin}?payment=success`
            };

            try {
                const paymentLinkData = await payos.createPaymentLink(paymentData);
                
                await ddbDocClient.send(new PutCommand({
                    TableName: TABLE_NAME,
                    Item: {
                        PK: `TENANT#${tenantId}`,
                        SK: `BILLING#ORDER#${orderCode}`,
                        Amount: amount,
                        Package: packageName,
                        Status: "PENDING",
                        CreatedAt: timestamp
                    }
                }));

                return success(200, { checkoutUrl: paymentLinkData.checkoutUrl });
            } catch (err) {
                console.error("Lỗi tạo link thanh toán PayOS:", err);
                return error(500, "Lỗi tích hợp cổng thanh toán PayOS: " + err.message);
            }
        }

        return error(405, "Phương thức HTTP không được hỗ trợ!");
    } catch (err) {
        console.error("Lỗi Lambda Subscription:", err);
        return error(500, err.message);
    }
};
