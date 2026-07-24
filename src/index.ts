import * as dotenv from "dotenv";
import { App, ExpressReceiver } from "@slack/bolt";
import * as events from "./events/index";

dotenv.config();

const expressReceiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_BOLT_SIGNING_SECRET,
});
export const app = new App({
  token: process.env.SLACK_BOLT_TOKEN,
  receiver: expressReceiver,
});
expressReceiver.app.get("/", (req, res) => {
  res.status(200).type("text/plain").send("hi, this is Hack Club's hall of fame");
});

expressReceiver.app.get("/status", (req, res) => {
  res.status(200).send();
});

(async (): Promise<void> => {
  await app.start(Number(process.env.PORT) || 3000);
  console.log("Server started!");

  // credits to Rishi (https://github.com/rishiosaur) for this
  for (const [event, handler] of Object.entries(events)) {
    handler(app);
    console.log(`Loaded event: ${event}`);
  }
})();
