import { Route, Routes } from "react-router-dom";

import { ProfilePickerRoute } from "./routes/ProfilePickerRoute";
import { CarouselListRoute } from "./routes/CarouselListRoute";
import { EditorRoute } from "./routes/EditorRoute";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<ProfilePickerRoute />} />
      <Route path="/:slug/carousels" element={<CarouselListRoute />} />
      <Route path="/:slug/carousels/:id" element={<EditorRoute />} />
    </Routes>
  );
}
