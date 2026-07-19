const { ddbDocClient, TABLE_NAME } = require("../../shared/database");
const { extractIdentity, verifyOrigin } = require("../../shared/auth");
const { success, error, cors } = require("../../shared/response");
const { PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { 
    CognitoIdentityProviderClient, 
    AdminCreateUserCommand, 
    AdminSetUserPasswordCommand,
    AdminDeleteUserCommand,
    AdminUpdateUserAttributesCommand,
    AdminDisableUserCommand,
    AdminEnableUserCommand
} = require("@aws-sdk/client-cognito-identity-provider");

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || "ap-southeast-1" });
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

function formatPhone(phone) {
    if (!phone) return phone;
    let trimmed = phone.trim();
    if (trimmed.startsWith("+")) return trimmed;
    if (trimmed.startsWith("0")) return "+84" + trimmed.slice(1);
    return "+84" + trimmed;
}

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

        const { tenantId, role, userId: callerUserId } = identity;
        const path = (event.requestContext?.http?.path || "").replace(/^\/prod/, "");
        const method = event.requestContext?.http?.method || "GET";
        const queryParams = event.queryStringParameters || {};

        // Role enforcement: only ADMIN/MANAGER can access
        if (role !== "ADMIN" && role !== "MANAGER") {
            if (process.env.AWS_SAM_LOCAL !== "true" && process.env.NODE_ENV !== "development") {
                return error(403, "Quyền truy cập bị từ chối: Chỉ quản trị viên mới có quyền thực hiện thao tác này!");
            }
        }

        // ─── 1. GET /admin/users ───
        if (path === "/admin/users" && method === "GET") {
            const result = await ddbDocClient.send(new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
                ExpressionAttributeValues: {
                    ":pk": `TENANT#${tenantId}`,
                    ":sk_prefix": "USER#"
                }
            }));

            let users = (result.Items || [])
                .filter(item => item.SK.endsWith("#METADATA"))
                .map(item => ({
                    userId: item.SK.split("#")[1],
                    fullName: item.FullName || "",
                    email: item.Email || "",
                    phone: item.Phone || "",
                    role: item.Role || "EMPLOYEE",
                    isActive: item.IsActive !== false,
                    isVerified: item.IsVerified || false,
                    createdAt: item.CreatedAt || ""
                }));

            // Manager boundary
            if (role === "MANAGER") {
                users = users.filter(u => u.role !== "ADMIN");
            }

            return success(200, { users, count: users.length, tenantId });
        }

        // ─── 2. PATCH /admin/users (Role & Active status - Admin only) ───
        if (path === "/admin/users" && method === "PATCH") {
            if (role !== "ADMIN") {
                return error(403, "Quyền hạn không hợp lệ: Chỉ quản trị viên cấp cao (ADMIN) mới có quyền chỉnh sửa vai trò.");
            }

            const body = JSON.parse(event.body || "{}");
            const { targetUserId, newRole, isActive } = body;

            if (!targetUserId) {
                return error(400, "Thiếu thông tin người dùng cần cập nhật (targetUserId)!");
            }

            const updateExpressions = [];
            const expressionAttributeNames = {};
            const expressionAttributeValues = {};

            if (newRole !== undefined) {
                const validRoles = ["EMPLOYEE", "MANAGER", "ADMIN"];
                if (!validRoles.includes(newRole)) {
                    return error(400, `Vai trò không hợp lệ! Chỉ chấp nhận: ${validRoles.join(", ")}`);
                }
                updateExpressions.push("#role = :role");
                expressionAttributeNames["#role"] = "Role";
                expressionAttributeValues[":role"] = newRole;

                // Sync custom:role to Cognito
                try {
                    await cognitoClient.send(new AdminUpdateUserAttributesCommand({
                        UserPoolId: USER_POOL_ID,
                        Username: `${tenantId}#${targetUserId}`,
                        UserAttributes: [{ Name: "custom:role", Value: newRole }]
                    }));
                } catch (e) {
                    console.warn(`Lỗi đồng bộ role lên Cognito cho ${targetUserId}:`, e.message);
                }
            }

            if (isActive !== undefined) {
                updateExpressions.push("#active = :active");
                expressionAttributeNames["#active"] = "IsActive";
                expressionAttributeValues[":active"] = isActive;

                // Disable/Enable in Cognito
                try {
                    const username = `${tenantId}#${targetUserId}`;
                    if (isActive === false) {
                        await cognitoClient.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
                    } else {
                        await cognitoClient.send(new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
                    }
                } catch (e) {
                    console.warn(`Lỗi cập nhật trạng thái Cognito cho ${targetUserId}:`, e.message);
                }
            }

            if (updateExpressions.length === 0) {
                return error(400, "Không có thông tin thay đổi nào được gửi!");
            }

            updateExpressions.push("#updatedAt = :updatedAt");
            expressionAttributeNames["#updatedAt"] = "UpdatedAt";
            expressionAttributeValues[":updatedAt"] = new Date().toISOString();

            await ddbDocClient.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: {
                    PK: `TENANT#${tenantId}`,
                    SK: `USER#${targetUserId}#METADATA`
                },
                UpdateExpression: "SET " + updateExpressions.join(", "),
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues
            }));

            return success(200, { message: `Đã cập nhật thông tin người dùng ${targetUserId} thành công!` });
        }

        // ─── 3. POST /admin/users/create (Admin only - bypass OTP) ───
        if (path === "/admin/users/create" && method === "POST") {
            if (role !== "ADMIN") {
                return error(403, "Chỉ quản trị viên (ADMIN) mới có quyền tạo tài khoản mới!");
            }

            const body = JSON.parse(event.body || "{}");
            const { userId, password, fullName, email, phone, newRole } = body;

            if (!userId || !password) {
                return error(400, "Vui lòng nhập tài khoản và mật khẩu!");
            }

            const formattedPhone = formatPhone(phone);
            const cognitoUsername = `${tenantId}#${userId}`;
            const assignedRole = ["EMPLOYEE", "MANAGER", "ADMIN"].includes(newRole) ? newRole : "EMPLOYEE";

            // Check existing in DB
            const existing = await ddbDocClient.send(new GetCommand({
                TableName: TABLE_NAME,
                Key: { PK: `TENANT#${tenantId}`, SK: `USER#${userId}#METADATA` }
            }));
            if (existing.Item) {
                return error(409, `Tài khoản "${userId}" đã tồn tại trong hệ thống!`);
            }

            try {
                // Admin creates user directly in Cognito User Pool as CONFIRMED
                await cognitoClient.send(new AdminCreateUserCommand({
                    UserPoolId: USER_POOL_ID,
                    Username: cognitoUsername,
                    UserAttributes: [
                        { Name: "email", Value: email || `${userId}@example.com` },
                        { Name: "phone_number", Value: formattedPhone || "+84900000000" },
                        { Name: "custom:tenantId", Value: tenantId },
                        { Name: "custom:role", Value: assignedRole }
                    ],
                    MessageAction: "SUPPRESS"
                }));

                await cognitoClient.send(new AdminSetUserPasswordCommand({
                    UserPoolId: USER_POOL_ID,
                    Username: cognitoUsername,
                    Password: password,
                    Permanent: true
                }));

                // Save user metadata directly
                await ddbDocClient.send(new PutCommand({
                    TableName: TABLE_NAME,
                    Item: {
                        PK: `TENANT#${tenantId}`,
                        SK: `USER#${userId}#METADATA`,
                        FullName: fullName || userId,
                        Email: email || "",
                        Phone: phone || "",
                        Role: assignedRole,
                        IsActive: true,
                        IsVerified: true,
                        CreatedAt: new Date().toISOString()
                    }
                }));

                return success(200, { message: `Tạo tài khoản "${userId}" (${assignedRole}) thành công!` });
            } catch (err) {
                console.error("Lỗi Admin Tạo user:", err);
                return error(500, "Không thể tạo tài khoản: " + err.message);
            }
        }

        // ─── 4. PATCH /admin/users/profile (Admin only) ───
        if (path === "/admin/users/profile" && method === "PATCH") {
            if (role !== "ADMIN") {
                return error(403, "Chỉ quản trị viên (ADMIN) mới có quyền chỉnh sửa hồ sơ nhân viên!");
            }

            const body = JSON.parse(event.body || "{}");
            const { targetUserId, fullName, email, phone } = body;

            if (!targetUserId) {
                return error(400, "Thiếu thông tin người dùng cần cập nhật!");
            }

            const updateExpressions = [];
            const expressionAttributeNames = {};
            const expressionAttributeValues = {};

            if (fullName !== undefined) {
                updateExpressions.push("#fn = :fullName");
                expressionAttributeNames["#fn"] = "FullName";
                expressionAttributeValues[":fullName"] = fullName;
            }
            if (email !== undefined) {
                updateExpressions.push("#em = :email");
                expressionAttributeNames["#em"] = "Email";
                expressionAttributeValues[":email"] = email;
            }
            if (phone !== undefined) {
                updateExpressions.push("#ph = :phone");
                expressionAttributeNames["#ph"] = "Phone";
                expressionAttributeValues[":phone"] = phone;
            }

            if (updateExpressions.length === 0) {
                return error(400, "Không có thông tin thay đổi nào!");
            }

            updateExpressions.push("#updatedAt = :updatedAt");
            expressionAttributeNames["#updatedAt"] = "UpdatedAt";
            expressionAttributeValues[":updatedAt"] = new Date().toISOString();

            await ddbDocClient.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` },
                UpdateExpression: "SET " + updateExpressions.join(", "),
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues
            }));

            // Sync to Cognito attributes
            try {
                const userAttributes = [];
                if (email !== undefined) userAttributes.push({ Name: "email", Value: email });
                if (phone !== undefined) userAttributes.push({ Name: "phone_number", Value: formatPhone(phone) });
                if (userAttributes.length > 0) {
                    await cognitoClient.send(new AdminUpdateUserAttributesCommand({
                        UserPoolId: USER_POOL_ID,
                        Username: `${tenantId}#${targetUserId}`,
                        UserAttributes: userAttributes
                    }));
                }
            } catch (e) {
                console.warn(`Lỗi đồng bộ thông tin lên Cognito cho ${targetUserId}:`, e.message);
            }

            return success(200, { message: `Đã cập nhật hồ sơ nhân viên ${targetUserId} thành công!` });
        }

        // ─── 5. DELETE /admin/users/delete (Admin only) ───
        if (path === "/admin/users/delete" && method === "DELETE") {
            if (role !== "ADMIN") {
                return error(403, "Chỉ quản trị viên (ADMIN) mới có quyền xóa tài khoản!");
            }

            const body = JSON.parse(event.body || "{}");
            const { targetUserId } = body;

            if (!targetUserId) {
                return error(400, "Thiếu thông tin tài khoản cần xóa!");
            }

            if (targetUserId === callerUserId) {
                return error(400, "Bạn không thể tự xóa tài khoản của chính mình!");
            }

            try {
                // Delete from Cognito User Pool
                await cognitoClient.send(new AdminDeleteUserCommand({
                    UserPoolId: USER_POOL_ID,
                    Username: `${tenantId}#${targetUserId}`
                }));

                // Delete metadata record
                await ddbDocClient.send(new DeleteCommand({
                    TableName: TABLE_NAME,
                    Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` }
                }));

                // Clean up user attendance
                const attendanceResult = await ddbDocClient.send(new QueryCommand({
                    TableName: TABLE_NAME,
                    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
                    ExpressionAttributeValues: {
                        ":pk": `TENANT#${tenantId}`,
                        ":sk_prefix": `USER#${targetUserId}#ATTENDANCE#`
                    }
                }));

                const attendanceItems = attendanceResult.Items || [];
                for (const item of attendanceItems) {
                    await ddbDocClient.send(new DeleteCommand({
                        TableName: TABLE_NAME,
                        Key: { PK: item.PK, SK: item.SK }
                    }));
                }

                return success(200, { message: `Đã xóa tài khoản "${targetUserId}" và ${attendanceItems.length} bản ghi chấm công liên quan.` });
            } catch (err) {
                console.error("Lỗi Admin Xóa User:", err);
                return error(500, "Lỗi xóa tài khoản nhân sự: " + err.message);
            }
        }

        // ─── 6. GET /admin/attendance/summary (Admin & Manager) ───
        if (path === "/admin/attendance/summary" && method === "GET") {
            const result = await ddbDocClient.send(new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk_prefix)",
                ExpressionAttributeValues: {
                    ":pk": `TENANT#${tenantId}`,
                    ":sk_prefix": "USER#"
                }
            }));

            const items = result.Items || [];
            const userMetadata = {};

            // Map user metadata (Filter out admins for Managers)
            items.forEach(item => {
                if (item.SK.endsWith("#METADATA")) {
                    const uId = item.SK.split("#")[1];
                    if (role === "MANAGER" && item.Role === "ADMIN") {
                        return;
                    }
                    userMetadata[uId] = {
                        fullName: item.FullName || uId,
                        role: item.Role || "EMPLOYEE"
                    };
                }
            });

            const stats = {};
            Object.keys(userMetadata).forEach(uId => {
                stats[uId] = {
                    userId: uId,
                    fullName: userMetadata[uId].fullName,
                    role: userMetadata[uId].role,
                    checkins: 0,
                    checkouts: 0,
                    days: new Set()
                };
            });

            // Loop items to summarize
            items.forEach(item => {
                if (item.SK.includes("#ATTENDANCE#")) {
                    const uId = item.UserId || item.SK.split("#")[1];
                    if (stats[uId]) {
                        if (item.Action === "CHECKIN") stats[uId].checkins++;
                        if (item.Action === "CHECKOUT") stats[uId].checkouts++;
                        const date = item.Timestamp?.substring(0, 10);
                        if (date) stats[uId].days.add(date);
                    }
                }
            });

            const summaryList = Object.values(stats).map(s => ({
                userId: s.userId,
                fullName: s.fullName,
                role: s.role,
                checkins: s.checkins,
                checkouts: s.checkouts,
                days: s.days.size
            }));

            return success(200, { summary: summaryList });
        }

        // ─── 7. POST /admin/attendance (Create manual log - Admin/Manager) ───
        if (path === "/admin/attendance" && method === "POST") {
            const body = JSON.parse(event.body || "{}");
            const { targetUserId, timestamp, action, device } = body;

            if (!targetUserId || !timestamp || !action) {
                return error(400, "Vui lòng điền đầy đủ: Tài khoản, Thời gian, Loại ca!");
            }

            // Manager boundary check
            if (role === "MANAGER") {
                const checkUser = await ddbDocClient.send(new GetCommand({
                    TableName: TABLE_NAME,
                    Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` }
                }));
                if (checkUser.Item && checkUser.Item.Role === "ADMIN") {
                    return error(403, "Quyền hạn không hợp lệ: Không thể thêm log chấm công cho tài khoản ADMIN.");
                }
            }

            const dateStr = timestamp.substring(0, 10);
            const actionType = action === "CHECKOUT" ? "CHECKOUT" : "CHECKIN";
            const logRecord = {
                PK: `TENANT#${tenantId}`,
                SK: `USER#${targetUserId}#ATTENDANCE#${dateStr}#${actionType}`,
                UserId: targetUserId,
                Timestamp: timestamp,
                Action: actionType,
                DeviceVerified: device || "Điều chỉnh thủ công",
                Status: "SUCCESS"
            };

            await ddbDocClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: logRecord
            }));

            return success(200, { message: "Thêm bản ghi chấm công thủ công thành công!", record: logRecord });
        }

        // ─── 8. PATCH /admin/attendance (Update log - Admin/Manager) ───
        if (path === "/admin/attendance" && method === "PATCH") {
            const body = JSON.parse(event.body || "{}");
            const { targetUserId, originalSk, newTimestamp, newAction, newDevice } = body;

            if (!targetUserId || !originalSk || !newTimestamp || !newAction) {
                return error(400, "Thiếu dữ liệu điều chỉnh!");
            }

            // Manager boundary check
            if (role === "MANAGER") {
                const checkUser = await ddbDocClient.send(new GetCommand({
                    TableName: TABLE_NAME,
                    Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` }
                }));
                if (checkUser.Item && checkUser.Item.Role === "ADMIN") {
                    return error(403, "Quyền hạn không hợp lệ: Không thể sửa đổi dữ liệu chấm công của ADMIN.");
                }
            }

            // Delete old key
            await ddbDocClient.send(new DeleteCommand({
                TableName: TABLE_NAME,
                Key: {
                    PK: `TENANT#${tenantId}`,
                    SK: originalSk
                }
            }));

            // Write new key
            const dateStr = newTimestamp.substring(0, 10);
            const actionType = newAction === "CHECKOUT" ? "CHECKOUT" : "CHECKIN";
            const newSk = `USER#${targetUserId}#ATTENDANCE#${dateStr}#${actionType}`;

            const updatedRecord = {
                PK: `TENANT#${tenantId}`,
                SK: newSk,
                UserId: targetUserId,
                Timestamp: newTimestamp,
                Action: actionType,
                DeviceVerified: newDevice || "Chỉnh sửa thủ công",
                Status: "SUCCESS"
            };

            await ddbDocClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: updatedRecord
            }));

            return success(200, { message: "Đã cập nhật bản ghi chấm công thành công!", record: updatedRecord });
        }

        // ─── 9. DELETE /admin/attendance (Delete log - Admin/Manager) ───
        if (path === "/admin/attendance" && method === "DELETE") {
            const body = JSON.parse(event.body || "{}");
            const { targetUserId, sk } = body;

            if (!targetUserId || !sk) {
                return error(400, "Thiếu thông tin bản ghi cần xóa!");
            }

            // Manager boundary check
            if (role === "MANAGER") {
                const checkUser = await ddbDocClient.send(new GetCommand({
                    TableName: TABLE_NAME,
                    Key: { PK: `TENANT#${tenantId}`, SK: `USER#${targetUserId}#METADATA` }
                }));
                if (checkUser.Item && checkUser.Item.Role === "ADMIN") {
                    return error(403, "Quyền hạn không hợp lệ: Không thể xóa dữ liệu chấm công của ADMIN.");
                }
            }

            await ddbDocClient.send(new DeleteCommand({
                TableName: TABLE_NAME,
                Key: {
                    PK: `TENANT#${tenantId}`,
                    SK: sk
                }
            }));

            return success(200, { message: "Đã xóa bản ghi chấm công thành công!" });
        }

        return error(405, "Phương thức HTTP không hỗ trợ!");
    } catch (err) {
        console.error("Lỗi Lambda Admin Tổng hợp:", err);
        return error(500, err.message);
    }
};
