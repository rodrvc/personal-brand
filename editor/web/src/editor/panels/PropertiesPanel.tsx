import type { BrandTokens, CarouselDocument, LayoutTemplate, StatsResponse } from "../../api/types";
import type { PanelTab } from "../Editor";
import type { Selection } from "../geometry";
import { SelectionPane } from "./SelectionPane";
import { BucketPane } from "./BucketPane";
import { SlidePane } from "./SlidePane";
import { BrandPane } from "./BrandPane";
import { TemplatesPane } from "./TemplatesPane";
import { t } from "../../i18n";
import type { LocaleKey } from "../../i18n";
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
  onTemplateChange: (next: LayoutTemplate) => void;
}

/** Tab id → its LocaleKey, in display order. `t()` is called lazily, in `panelTabs()`, never at module load. */
const TAB_LABEL_KEY: Array<{ id: PanelTab; labelKey: LocaleKey }> = [
  { id: "sel", labelKey: "propertiesPanel.tab.selection" },
  { id: "bucket", labelKey: "propertiesPanel.tab.bucket" },
  { id: "lam", labelKey: "propertiesPanel.tab.slide" },
  { id: "marca", labelKey: "propertiesPanel.tab.brand" },
  { id: "templates", labelKey: "propertiesPanel.tab.templates" },
];

function panelTabs(): Array<{ id: PanelTab; label: string }> {
  return TAB_LABEL_KEY.map(({ id, labelKey }) => ({ id, label: t(labelKey) }));
}

export function PropertiesPanel(props: PropertiesPanelProps) {
  const { doc, activeIndex, panelTab, onPanelTabChange } = props;
  const slide = doc.slides[activeIndex];

  return (
    <aside className="props-panel">
      <div className="props-tabs" role="tablist">
        {panelTabs().map((tab) => (
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
        {panelTab === "templates" && (
          <TemplatesPane
            mode="select"
            slug={props.slug}
            doc={doc}
            template={props.template}
            onDocUpdate={props.onDocUpdate}
            onTemplateChange={props.onTemplateChange}
          />
        )}
      </div>
    </aside>
  );
}
