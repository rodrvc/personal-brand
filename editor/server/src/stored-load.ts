import type { Page } from "playwright";

import { loadWithResolver, type AssetResolve } from "../../../system/ig-carousel/render-batch.js";

import { StorageFailure } from "./stored-read.js";

/** Loads a page and returns its late check; injectable so the classification below is testable without a browser. */
export type LoadWithResolver = (page: Page, html: string, resolve: AssetResolve) => Promise<() => void>;

/**
 * Loads a stored slide's HTML into `page`, serving its assets through `resolve`. Returns the late check: call it after
 * fonts settle, because a request refused after "idle" must not reach the screenshot. Only a failure of the resolver's
 * own storage reads (a `StorageFailure`) is reported as an outage, from the load and from the late check alike; a
 * refusal for any other reason stays the render error it is.
 */
export async function loadStoredSlide(page: Page, html: string, resolve: AssetResolve, load: LoadWithResolver = loadWithResolver): Promise<() => void> {
  let outage: StorageFailure | undefined;
  const watched: AssetResolve = async (assetId) => {
    try {
      return await resolve(assetId);
    } catch (error) {
      if (error instanceof StorageFailure) outage = error;
      throw error;
    }
  };
  const classify = (error: unknown): unknown => (outage ? outage : error);
  let check: () => void;
  try {
    check = await load(page, html, watched);
  } catch (error) {
    throw classify(error);
  }
  return () => {
    try {
      check();
    } catch (error) {
      throw classify(error);
    }
  };
}
