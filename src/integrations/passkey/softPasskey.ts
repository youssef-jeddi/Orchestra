// ─── Test helper: a software passkey ───
// A P-256 key like a phone's secure chip holds, producing real WebAuthn
// registration and assertion responses, so tests run the actual verification.

import crypto from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

export const TEST_RP = { rpID: "localhost", origin: "http://localhost:3000" };

export function softPasskey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], // kty EC2, alg ES256, crv P-256
    [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")],
  ]));
  const rawId = crypto.randomBytes(16);
  const id = rawId.toString("base64url");
  const rpIdHash = (rpID: string) => crypto.createHash("sha256").update(rpID).digest();
  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin }));

  return {
    id,
    publicKey: Buffer.from(cose).toString("base64url"),
    /** A registration response (attestation "none") for `challenge`. */
    register(challenge: string, origin = TEST_RP.origin, rpID = TEST_RP.rpID) {
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(rawId.length);
      const authData = Buffer.concat([
        rpIdHash(rpID), Buffer.from([0x45]), Buffer.alloc(4), // user present + verified, attested data
        Buffer.alloc(16), idLen, rawId, Buffer.from(cose), // AAGUID, credential id, public key
      ]);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as any);
      return {
        id, rawId: id, type: "public-key", clientExtensionResults: {},
        response: {
          clientDataJSON: clientData("webauthn.create", challenge, origin).toString("base64url"),
          attestationObject: Buffer.from(attestationObject).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    /** An assertion over `challenge`. */
    assert(challenge: string, origin = TEST_RP.origin, rpID = TEST_RP.rpID) {
      const authData = Buffer.concat([rpIdHash(rpID), Buffer.from([0x05]), Buffer.alloc(4)]); // user present + verified
      const data = clientData("webauthn.get", challenge, origin);
      const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(data).digest()]), privateKey);
      return {
        id, rawId: id, type: "public-key", clientExtensionResults: {},
        response: {
          authenticatorData: authData.toString("base64url"),
          clientDataJSON: data.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
  };
}
