const https = require('https');

exports.handler = async (event) => {
    const snsMessage = event.Records[0].Sns.Message;

    let message = '';
    let color = '';

    const data = JSON.stringify({
        attachments: [
            {
                mrkdwn_in: ['text'],
                fallback: message,
                color,
                text: snsMessage,
            },
        ],
    });
    return new Promise((resolve, reject) => {
        const request = https.request(
            process.env.WEBHOOK_URL,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length,
                },
            },
            (res) => {
                res.on('end', () => resolve());
            },
        );
        request.write(data);
        request.end();
    });
};
