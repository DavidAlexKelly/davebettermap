import { createClient, type Client } from "@osdk/client";
import { createPublicOauthClient, type PublicOauthClient } from "@osdk/oauth";

function getMetaTagContent(tagName: string): string {
  const elements = document.querySelectorAll(`meta[name="${tagName}"]`);
  const element = elements.item(elements.length - 1);
  const value = element ? element.getAttribute("content") : null;
  if (value == null || value === "") {
    throw new Error(`Meta tag ${tagName} not found or empty`);
  }
  if (value.match(/%.+%/)) {
    throw new Error(
      `Meta tag ${tagName} contains placeholder value. Please add ${value.replace(
        /%/g,
        ""
      )} to your .env files`
    );
  }
  return value;
}

const foundryUrl = getMetaTagContent("osdk-foundryUrl");
const clientId = getMetaTagContent("osdk-clientId");
const redirectUrl = getMetaTagContent("osdk-redirectUrl");
const ontologyRid = getMetaTagContent("osdk-ontologyRid");

const scopes = [
  "api:use-ontologies-read",
  "api:use-ontologies-write",
  "api:use-datasets-read",
  "api:use-datasets-write",
  "api:use-filesystem-read",
  "api:use-filesystem-write",
  "api:use-streams-read",
  "api:use-streams-write",
  "api:mediasets-read",
];

export const auth: PublicOauthClient = createPublicOauthClient(
  clientId,
  foundryUrl,
  redirectUrl,
  { scopes }
);

/**
 * Initialize the client to interact with the Ontology and Platform SDKs
 */
export const client: Client = createClient(foundryUrl, ontologyRid, auth);

export default client;
