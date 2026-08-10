/**
 * MapLibre under Remotion's clock.
 *
 * The map is a live WebGL renderer that Remotion treats as a still per frame:
 * the camera is computed from `useCurrentFrame()` and applied with `jumpTo()`
 * (never `flyTo()` — the map must not own any animation of its own), and every
 * frame blocks on `delayRender()` until the tiles for that camera are loaded.
 * `--concurrency=1 --gl=swangle` at render time is part of the same contract:
 * headless Chromium cannot host several WebGL contexts reliably.
 *
 * The basemap is CARTO's no-key Voyager raster tiles. This engine deliberately
 * does NOT use openstreetmap.org tiles (their policy forbids pre-emptive
 * fetching, which rendering a video is) nor Google/Mapbox imagery (barred from
 * promotional content / separately licensed). CARTO's basemaps are usable with
 * the attribution the style declares here, which is why the composition prints
 * it on every map scene and no profile field can turn it off.
 */

import maplibregl, { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { continueRender, delayRender } from 'remotion';

import type { Camera } from './timeline';

/** Required by the basemap's terms; drawn over every map scene. */
export const MAP_ATTRIBUTION = '© OpenStreetMap contributors © CARTO';

const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      // Derived from the same constant the composition draws, so the credit
      // required by the basemap's terms has a single source of truth. The
      // attribution field is plain HTML; a literal "©" needs no escaping.
      attribution: MAP_ATTRIBUTION,
    },
  },
  layers: [
    {
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      // Tiles must not fade in on their own clock: a fade that spans frames
      // renders as flicker once the frames are stitched.
      paint: { 'raster-fade-duration': 0 },
    },
  ],
};

/**
 * Creates the map once and re-aims it every time the camera changes, holding
 * Remotion's render until the tiles for the new camera have arrived.
 */
export const useMapLibre = (camera: Camera) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const pendingFrameHandle = useRef<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const handle = delayRender('MapLibre initial style and first tiles');
    const timeout = window.setTimeout(() => {
      setLoaded(true);
      continueRender(handle);
    }, 6000);

    if (!containerRef.current) {
      return () => {
        window.clearTimeout(timeout);
        continueRender(handle);
      };
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: camera.center,
      zoom: camera.zoom,
      bearing: camera.bearing,
      pitch: camera.pitch,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      canvasContextAttributes: {
        // Without this the canvas is cleared before Remotion screenshots it.
        preserveDrawingBuffer: true,
      },
    });

    mapRef.current = map;

    const markReady = () => {
      map.resize();
      window.clearTimeout(timeout);
      setLoaded(true);
      continueRender(handle);
    };

    window.requestAnimationFrame(() => {
      // Headless Chromium reports the container size late; resizing before the
      // first jump is what stops the first frames rendering at 300x150.
      map.resize();
      map.jumpTo(camera);
    });

    map.once('idle', markReady);
    map.once('error', (event) => {
      window.clearTimeout(timeout);
      console.warn('MapLibre error while loading map', event);
      setLoaded(true);
      continueRender(handle);
    });

    return () => {
      window.clearTimeout(timeout);
      map.remove();
      mapRef.current = null;
      continueRender(handle);
    };
    // The map is created once; camera changes go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) {
      return;
    }

    if (pendingFrameHandle.current !== null) {
      continueRender(pendingFrameHandle.current);
      pendingFrameHandle.current = null;
    }

    const handle = delayRender('MapLibre frame tiles');
    pendingFrameHandle.current = handle;

    map.resize();
    map.jumpTo(camera);

    const finish = () => {
      if (pendingFrameHandle.current === handle) {
        pendingFrameHandle.current = null;
        continueRender(handle);
      }
    };

    // A tile the CDN never answers must cost 1.2s, not the whole render.
    const timeout = window.setTimeout(finish, 1200);

    if (map.areTilesLoaded()) {
      finish();
    } else {
      map.once('idle', finish);
    }

    return () => {
      window.clearTimeout(timeout);
      map.off('idle', finish);
      if (pendingFrameHandle.current === handle) {
        pendingFrameHandle.current = null;
        continueRender(handle);
      }
    };
  }, [camera, loaded]);

  return { containerRef, loaded };
};
