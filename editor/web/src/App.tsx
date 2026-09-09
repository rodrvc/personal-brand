import { Route, Routes } from "react-router-dom";

import { ProfilePickerRoute } from "./routes/ProfilePickerRoute";
import { CarouselListRoute } from "./routes/CarouselListRoute";
import { EditorRoute } from "./routes/EditorRoute";
import { useTheme } from "./hooks/useTheme";

/**
 * useTheme() is called once here, at the top of the route tree, so
 * `data-theme` stays in sync with the stored choice on every route — not
 * just inside the editor. `index.html`'s inline script already set the
 * right `data-theme` before React's first paint (it reads the same
 * localStorage key `useTheme` does, defaulting to "light" regardless of OS
 * preference — see that script's own comment); this hook is what keeps it
 * correct afterward and lets the top-bar toggle change it live. Without
 * calling it here, routes that never mounted the editor (profile picker,
 * carousel list, and any modal opened from them) would never react to a
 * theme change made from the editor.
 */
export function App() {
  const { theme, toggleTheme } = useTheme();

  return (
    <Routes>
      <Route path="/" element={<ProfilePickerRoute />} />
      <Route path="/:slug/carousels" element={<CarouselListRoute />} />
      <Route path="/:slug/carousels/:id" element={<EditorRoute theme={theme} onToggleTheme={toggleTheme} />} />
    </Routes>
  );
}
