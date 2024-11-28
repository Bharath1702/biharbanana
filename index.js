const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express().use(bodyParser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

let userSessions = {};

// Start server
app.listen(process.env.PORT || 80, () => {
    console.log("Webhook is listening");
});

app.get("/webhook", (req, res) => {
    let mode = req.query["hub.mode"];
    let challenge = req.query["hub.challenge"];
    let token = req.query["hub.verify_token"];

    if (mode && token) {
        if (mode === "subscribe" && token === mytoken) {
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

app.post("/webhook", async (req, res) => {
    try {
        let body_param = req.body;

        console.log(JSON.stringify(body_param, null, 2));

        if (body_param.object) {
            if (body_param.entry &&
                body_param.entry[0].changes &&
                body_param.entry[0].changes[0].value.messages &&
                body_param.entry[0].changes[0].value.messages[0]
            ) {
                let phon_no_id = body_param.entry[0].changes[0].value.metadata.phone_number_id;
                let messageObj = body_param.entry[0].changes[0].value.messages[0];
                let from = messageObj.from;
                let msg_body = null;
                let isMediaMessage = false;
                let mediaId = null;
                let mediaType = null;
                let mediaMimeType = null;

                if (messageObj.image) {
                    isMediaMessage = true;
                    mediaId = messageObj.image.id;
                    mediaMimeType = messageObj.image.mime_type;
                    mediaType = 'image';
                } else if (messageObj.document) {
                    isMediaMessage = true;
                    mediaId = messageObj.document.id;
                    mediaMimeType = messageObj.document.mime_type;
                    mediaType = 'document';
                } else if (messageObj.video) {
                    isMediaMessage = true;
                    mediaId = messageObj.video.id;
                    mediaMimeType = messageObj.video.mime_type;
                    mediaType = 'video';
                } else if (messageObj.audio) {
                    isMediaMessage = true;
                    mediaId = messageObj.audio.id;
                    mediaMimeType = messageObj.audio.mime_type;
                    mediaType = 'audio';
                } else {
                    msg_body = (messageObj.interactive && messageObj.interactive.list_reply && messageObj.interactive.list_reply.id) ||
                               (messageObj.interactive && messageObj.interactive.button_reply && messageObj.interactive.button_reply.id) ||
                               (messageObj.text && messageObj.text.body);
                }

                console.log("phone number " + phon_no_id);
                console.log("from " + from);
                console.log("body param " + msg_body);

                await handleIncomingMessage(phon_no_id, from, msg_body, isMediaMessage, mediaId, mediaType);
                res.sendStatus(200);
            } else {
                res.sendStatus(404);
            }
        }
    } catch (error) {
        console.error("Error handling webhook event: ", error);
        res.sendStatus(500);
    }
});

function getUserSession(sender) {
    if (!userSessions[sender]) {
        userSessions[sender] = {
            state: 'GREETING',
            data: {},
            phon_no_id: null
        };
    }
    return userSessions[sender];
}

function generateUserId() {
    return uuidv4();
}

async function downloadMedia(mediaId) {
    try {
        // Get the media URL
        const mediaResponse = await axios({
            method: 'GET',
            url: `https://graph.facebook.com/v13.0/${mediaId}`,
            params: {
                access_token: token
            }
        });

        const mediaUrl = mediaResponse.data.url;

        // Download the media content
        const mediaContent = await axios({
            method: 'GET',
            url: mediaUrl,
            responseType: 'arraybuffer',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        return mediaContent.data; // This is the binary content
    } catch (error) {
        console.error('Error downloading media: ', error);
        return null;
    }
}

async function handleIncomingMessage(phon_no_id, sender, message, isMediaMessage, mediaId, mediaType) {
    try {
        let session = getUserSession(sender);
        session.phon_no_id = phon_no_id; // Save the phone number id for later use

        switch (session.state) {

            case 'GREETING':
                if (message && message.toLowerCase() === 'hi') {
                    await sendReply(phon_no_id, sender, 'Hi! Let\'s start your KYC process. Please upload a clear image of your Aadhar card.');
                    session.state = 'KYC_AADHAR';
                } else {
                    await sendReply(phon_no_id, sender, 'Please type "Hi" to start the KYC process.');
                }
                break;

            case 'KYC_AADHAR':
                if (isMediaMessage && mediaType === 'image') {
                    // Save Aadhar image
                    const mediaData = await downloadMedia(mediaId);
                    if (mediaData) {
                        // Save mediaData to storage with association to sender
                        // For this example, we will just store the mediaId
                        session.data.aadharMediaId = mediaId;
                        session.state = 'KYC_PAN';
                        await sendReply(phon_no_id, sender, 'Thank you. Now, please upload a clear image of your PAN card.');
                    } else {
                        await sendReply(phon_no_id, sender, 'Failed to download your Aadhar image. Please try again.');
                    }
                } else {
                    await sendReply(phon_no_id, sender, 'Please upload a clear image of your Aadhar card.');
                }
                break;

            case 'KYC_PAN':
                if (isMediaMessage && mediaType === 'image') {
                    // Save PAN image
                    const mediaData = await downloadMedia(mediaId);
                    if (mediaData) {
                        session.data.panMediaId = mediaId;
                        session.state = 'KYC_BANK';
                        await sendReply(phon_no_id, sender, 'Please provide your bank account number and IFSC code.');
                    } else {
                        await sendReply(phon_no_id, sender, 'Failed to download your PAN image. Please try again.');
                    }
                } else {
                    await sendReply(phon_no_id, sender, 'Please upload a clear image of your PAN card.');
                }
                break;

            case 'KYC_BANK':
                if (message) {
                    // Save bank details
                    session.data.bankDetails = message;
                    session.state = 'KYC_LAND';
                    await sendReply(phon_no_id, sender, 'Kindly provide the details of your land, including location and size.');
                } else {
                    await sendReply(phon_no_id, sender, 'Please provide your bank account number and IFSC code.');
                }
                break;

            case 'KYC_LAND':
                if (message) {
                    // Save land details
                    session.data.landDetails = message;
                    // Generate user ID
                    const userId = generateUserId();
                    session.data.userId = userId;
                    session.state = 'KYC_COMPLETE_WAITING_APPROVAL';
                    await sendReply(phon_no_id, sender, `Your user ID is ${userId}. We will notify you once your account is approved.`);
                    // Here you can notify admin or write code to handle approval
                    // For this example, we'll simulate approval after 10 seconds
                    setTimeout(() => {
                        session.state = 'APPROVED';
                        sendReply(session.phon_no_id, sender, 'Your account has been approved! You can now upload your products. Please upload a photo of the product you wish to sell.');
                    }, 10000);
                } else {
                    await sendReply(phon_no_id, sender, 'Please provide the details of your land, including location and size.');
                }
                break;

            case 'KYC_COMPLETE_WAITING_APPROVAL':
                // Waiting for admin approval
                await sendReply(phon_no_id, sender, 'Your account is under review. We will notify you once it is approved.');
                break;

            case 'APPROVED':
                // User's account is approved
                // Move to next state
                session.state = 'UPLOAD_PRODUCT_PHOTO';
                await sendReply(phon_no_id, sender, 'Your account has been approved! You can now upload your products. Please upload a photo of the product you wish to sell.');
                break;

            case 'UPLOAD_PRODUCT_PHOTO':
                if (isMediaMessage && mediaType === 'image') {
                    // Save product photo
                    const mediaData = await downloadMedia(mediaId);
                    if (mediaData) {
                        session.data.productPhotoId = mediaId;
                        session.state = 'UPLOAD_PRODUCT_VOLUME';
                        await sendReply(phon_no_id, sender, 'Please enter the volume/quantity of the product.');
                    } else {
                        await sendReply(phon_no_id, sender, 'Failed to download your product photo. Please try again.');
                    }
                } else {
                    await sendReply(phon_no_id, sender, 'Please upload a photo of the product.');
                }
                break;

            case 'UPLOAD_PRODUCT_VOLUME':
                if (message) {
                    // Save volume
                    session.data.productVolume = message;
                    session.state = 'UPLOAD_PRODUCT_PRICE';
                    await sendReply(phon_no_id, sender, 'What is your asking price for the product?');
                } else {
                    await sendReply(phon_no_id, sender, 'Please enter the volume/quantity of the product.');
                }
                break;

            case 'UPLOAD_PRODUCT_PRICE':
                if (message) {
                    // Save price
                    session.data.productPrice = message;
                    session.state = 'PRODUCT_UPLOADED';
                    await sendReply(phon_no_id, sender, 'Your product has been uploaded successfully.');
                } else {
                    await sendReply(phon_no_id, sender, 'Please provide your asking price for the product.');
                }
                break;

            default:
                await sendReply(phon_no_id, sender, 'I did not understand that. Please type "Hi" to start the process.');
        }
    } catch (error) {
        console.error("Error handling incoming message: ", error);
    }
}

async function sendReply(phon_no_id, sender, reply) {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v13.0/${phon_no_id}/messages?access_token=${token}`,
            data: {
                messaging_product: "whatsapp",
                to: sender,
                text: {
                    body: reply
                }
            },
            headers: {
                "Content-Type": "application/json"
            }
        });
    } catch (error) {
        console.error("Error sending reply: ", error.response ? error.response.data : error);
    }
}

app.get("/", (req, res) => {
    res.status(200).send("Hello, this is webhook setup on port " + (process.env.PORT || 3000));
});
