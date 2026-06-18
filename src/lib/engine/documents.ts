// The document (RAG) sources. Each PDF maps to a stable `doc` id (the [P:doc#page]
// citation namespace) + a human label. The structured and document domains share
// NO join key — see docs/architecture.md.
export type DocSpec = { doc: string; label: string; file: string };

export const DOCUMENTS: DocSpec[] = [
  {
    doc: "family-court",
    label: "Family Court Case File (Carter)",
    file: "📄 FAMILY COURT CASE FILE (MOCK) – FINAL VERSION.pdf",
  },
  {
    doc: "carter-story",
    label: "The Carter Family Story (background)",
    file: "story if the Carters .pdf",
  },
];

export type VectorRecord = { doc: string; page: number; text: string; embedding: number[] };
export type VectorIndex = { model: string; dim: number; records: VectorRecord[] };
