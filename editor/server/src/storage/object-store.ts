/**
 * The editor's name for the shared storage seam. The contract, the error
 * classes and the implementations live in `@personal-brand/storage`; this
 * file only re-exports them (same class identities, so `instanceof` works
 * across both) and goes away with the mirror in a later slice.
 */
export { ObjectNotFoundError, PreconditionFailedError } from "@personal-brand/storage/contracts";
export type {
  BlobGetResult as GetResult,
  BlobStreamResult as GetStreamResult,
  BlobHeadResult as HeadResult,
  BlobListEntry as ListedObject,
  BlobPutOptions as PutOptions,
  BlobPutResult as PutResult,
  BlobStore as ObjectStore,
} from "@personal-brand/storage/contracts";
