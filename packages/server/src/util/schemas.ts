import * as v from "valibot";

export const HexSchema = v.pipe(
  v.string(),
  v.regex(/^0x[0-9a-fA-F]*$/, "Must be a hex string starting with 0x"),
);

export const AddressSchema = v.pipe(
  v.string(),
  v.regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid Ethereum address (0x + 40 hex chars)"),
  v.check((val) => val.toLowerCase() !== "0x" + "0".repeat(40), "Zero address is not allowed"),
);

export const PublicInputsSchema = v.object({
  stateRoot: HexSchema,
  epoch: v.pipe(v.number(), v.integer(), v.minValue(0)),
  minBalance: v.string(),
  nullifier: HexSchema,
  blockNumber: v.pipe(v.string(), v.regex(/^\d+$/, "Must be a decimal block number string")),
});

export const ClaimRequestSchema = v.object({
  moduleId: v.pipe(v.string(), v.minLength(1)),
  proof: HexSchema,
  publicInputs: PublicInputsSchema,
  recipient: AddressSchema,
  targetNetwork: v.pipe(v.string(), v.minLength(1)),
});

export type ClaimRequest = v.InferOutput<typeof ClaimRequestSchema>;
export type PublicInputsDTO = v.InferOutput<typeof PublicInputsSchema>;
