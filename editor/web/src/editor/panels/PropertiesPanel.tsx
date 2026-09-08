import type { BrandTokens, CarouselDocument, LayoutTemplate, StatsResponse } from "../../api/types";
import type { PanelTab } from "../Editor";
import type { Selection } from "../geometry";
import { SelectionPane } from "./SelectionPane";
import { BucketPane } from "./BucketPane";
import { SlidePane } from "./SlidePane";
import { BrandPane } from "./BrandPane";
import "./PropertiesPanel.css";

interface PropertiesPanelProps {
  slug: string;
  brand: BrandTokens;
  template: LayoutTemplate;
  doc: CarouselDocument;
  renderVersion: number;
  activeIndex: number;
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  onDocUpdate: (updater: (prev: CarouselDocument) => CarouselDocument) => void;
  onDocReplace: (next: CarouselDocument) => void;
  panelTab: PanelTab;
  onPanelTabChange: (tab: PanelTab) => void;
  stats: StatsResponse | null;
  onStatsRefresh: (stats: StatsResponse) => void;
}

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: "sel", label: "Selección" },
  { id: "bucket", label: "Bucket" },
  { id: "lam", label: "Lámina" },
  { id: "marca", label: "Marca" },
];

export function PropertiesPanel(props: PropertiesPanelProps) {
  const { doc, activeIndex, panelTab, onPanelTabChange } = props;
  const slide = doc.slides[activeIndex];

  return (
    <aside className="props-panel">
      <div className="props-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className="props-tab"
            role="tab"
            aria-selected={panelTab === tab.id}
            onClick={() => onPanelTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="props-body">
        {slide && panelTab === "sel" && (
          <SelectionPane
            slug={props.slug}
            brand={props.brand}
            doc={doc}
            slide={slide}
            selection={props.selection}
            onSelectionChange={props.onSelectionChange}
            onDocUpdate={props.onDocUpdate}
            onDocReplace={props.onDocReplace}
          />
        )}
        {panelTab === "bucket" && (
          <BucketPane
            slug={props.slug}
            doc={doc}
            activeIndex={activeIndex}
            onDocUpdate={props.onDocUpdate}
            stats={props.stats}
          />
        )}
        {slide && panelTab === "lam" && (
          <SlidePane
            slug={props.slug}
            brand={props.brand}
            doc={doc}
            renderVersion={props.renderVersion}
            slide={slide}
            activeIndex={activeIndex}
            onDocUpdate={props.onDocUpdate}
            onDocReplace={props.onDocReplace}
          />
        )}
        {panelTab === "marca" && <BrandPane slug={props.slug} />}
      </div>
    </aside>
  );
}
