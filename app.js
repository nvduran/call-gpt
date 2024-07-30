require("./blob-shim");
require("dotenv").config();
require("colors");

const express = require("express");
const ExpressWs = require("express-ws");
const cors = require("cors");

const { GptService } = require("./services/gpt-service");
const { StreamService } = require("./services/stream-service");
const { TranscriptionService } = require("./services/transcription-service");
const { TextToSpeechService } = require("./services/tts-service");
const { recordingService } = require("./services/recording-service");

const VoiceResponse = require("twilio").twiml.VoiceResponse;
const twilio = require("twilio");

const app = express();
ExpressWs(app);

app.use(express.json());

const corsOptions = {
        origin: "http://127.0.0.1:5173", // Updated origin
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
        credentials: true,
};

app.use(cors(corsOptions));

const PORT = process.env.PORT || 3000;

// Verify environment variables
console.log("Twilio Account SID: ", process.env.TWILIO_ACCOUNT_SID ? "Loaded" : "Not Loaded");
console.log("Twilio Auth Token: ", process.env.TWILIO_AUTH_TOKEN ? "Loaded" : "Not Loaded");

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Store goals with call SIDs
const callGoals = new Map();

app.post("/incoming", (req, res) => {
        console.log("Incoming call");
        try {
                const response = new VoiceResponse();
                const connect = response.connect();
                connect.stream({ url: `wss://${process.env.SERVER}/connection` });
                console.log(response.toString());

                res.type("text/xml");
                res.end(response.toString());
        } catch (err) {
                console.log(err);
        }
});

app.post("/outbound", (req, res) => {
        console.log("Outbound call request received");
        try {
                const { to, from, goal, n2k, end_condition } = req.body;

                twilioClient.calls
                        .create({
                                url: `http://${process.env.SERVER}/outbound-call-response`,
                                to: to,
                                from: from,
                        })
                        .then((call) => {
                                console.log(`Outbound call initiated: ${call.sid}`);
                                callGoals.set(call.sid, goal); // Store the goal with the call SID
                                res.status(200).send({ message: "Call initiated", callSid: call.sid });
                        })
                        .catch((err) => {
                                console.error("Error initiating outbound call", err);
                                res.status(500).send({ message: "Error initiating call", error: err });
                        });
        } catch (err) {
                console.log(err);
        }
});

app.post("/outbound-call-response", (req, res) => {
        const response = new VoiceResponse();
        const connect = response.connect();
        connect.stream({ url: `wss://${process.env.SERVER}/connection` });
        console.log(response.toString());

        res.type("text/xml");
        res.end(response.toString());
});

app.ws("/connection", (ws, req) => {
        try {
                console.log("app.js -> Connection established".underline.blue);
                ws.on("error", console.error);
                let streamSid;
                let callSid;

                const gptService = new GptService();
                const streamService = new StreamService(ws);
                const transcriptionService = new TranscriptionService();
                const ttsService = new TextToSpeechService({});

                let marks = [];
                let interactionCount = 0;

                ws.on("message", function message(data) {
                        const msg = JSON.parse(data);
                        if (msg.event === "start") {
                                streamSid = msg.start.streamSid;
                                callSid = msg.start.callSid;

                                streamService.setStreamSid(streamSid);
                                gptService.setCallSid(callSid);

                                const goal = callGoals.get(callSid); // Retrieve the goal for this call
                                gptService.setGoal(goal); // Set the goal in the GPT service

                                recordingService(ttsService, callSid).then(() => {
                                        console.log(`Twilio -> Starting Media Stream for ${streamSid}`.underline.red);
                                        ttsService.generate({ partialResponseIndex: null, partialResponse: `Hello! Can I ${goal}?` }, 0);
                                });
                        } else if (msg.event === "media") {
                                transcriptionService.send(msg.media.payload);
                        } else if (msg.event === "mark") {
                                const label = msg.mark.name;
                                console.log(`Twilio -> Audio completed mark (${msg.sequenceNumber}): ${label}`.red);
                                marks = marks.filter((m) => m !== msg.mark.name);
                        } else if (msg.event === "stop") {
                                console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);
                        }
                });

                transcriptionService.on("utterance", async (text) => {
                        if (marks.length > 0 && text?.length > 5) {
                                console.log("Twilio -> Interruption, Clearing stream".red);
                                ws.send(
                                        JSON.stringify({
                                                streamSid,
                                                event: "clear",
                                        })
                                );
                        }
                });

                transcriptionService.on("transcription", async (text) => {
                        if (!text) {
                                return;
                        }
                        console.log(`Interaction ${interactionCount} – STT -> GPT: ${text}`.yellow);
                        gptService.completion(text, interactionCount);
                        interactionCount += 1;
                });

                gptService.on("gptreply", async (gptReply, icount) => {
                        console.log(`Interaction ${icount}: GPT -> TTS: ${gptReply.partialResponse}`.green);
                        ttsService.generate(gptReply, icount);
                });

                ttsService.on("speech", (responseIndex, audio, label, icount) => {
                        console.log(`Interaction ${icount}: TTS -> TWILIO: ${label}`.blue);
                        streamService.buffer(responseIndex, audio);
                });

                streamService.on("audiosent", (markLabel) => {
                        marks.push(markLabel);
                });
        } catch (err) {
                console.log(err);
        }
});

app.listen(PORT);
console.log(`Server running on port ${PORT}`);
