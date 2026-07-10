const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const sesClient = new SESClient({ region: process.env.AWS_REGION || "ap-southeast-1" });

exports.handler = async (event) => {
    console.log(`Processing ${event.Records.length} email records...`);

    const results = [];

    for (const record of event.Records) {
        try {
            const body = JSON.parse(record.body);
            const { toAddress, subject, textBody, htmlBody } = body;

            if (!toAddress || !subject || (!textBody && !htmlBody)) {
                throw new Error("Missing email details: toAddress, subject, and either textBody or htmlBody are required.");
            }

            const sourceEmail = process.env.SENDER_EMAIL || "noreply@your-domain.com";

            const command = new SendEmailCommand({
                Source: sourceEmail,
                Destination: {
                    ToAddresses: [toAddress],
                },
                Message: {
                    Subject: {
                        Data: subject,
                        Charset: "UTF-8",
                    },
                    Body: {
                        ...(textBody && {
                            Text: {
                                Data: textBody,
                                Charset: "UTF-8",
                            },
                        }),
                        ...(htmlBody && {
                            Html: {
                                Data: htmlBody,
                                Charset: "UTF-8",
                            },
                        }),
                    },
                },
            });

            const sendResult = await sesClient.send(command);
            console.log(`Email successfully sent to ${toAddress}. MessageId: ${sendResult.MessageId}`);
            results.push({ messageId: record.messageId, status: "SUCCESS" });
        } catch (err) {
            console.error(`Failed to process record ${record.messageId}:`, err);
            results.push({ messageId: record.messageId, status: "FAILED", error: err.message });
            // Re-throw if you want SQS to redrive this message to DLQ after maxReceiveCount
            throw err;
        }
    }

    return results;
};
