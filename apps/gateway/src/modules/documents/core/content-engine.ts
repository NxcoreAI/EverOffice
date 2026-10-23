import { WORKSPACE_DOCUMENT_CHANNEL, type TiptapJsonContent } from "@nxcore/agent-contract";
import type { ProjectedDocumentReference } from "@nxcore/document-model";
import { hasEmbeddedDocumentImages, migrateDocumentContent } from "@nxcore/document-model";
import {
  normalizeDocumentContent,
  normalizeDocumentFragment,
} from "../content-model.js";
import { DocumentServiceError } from "../errors.js";

export type NormalizedGatewayDocument = ReturnType<typeof normalizeDocumentContent>;

export interface DocumentContentEngineOptions {
  findDocumentRoom?: (documentId: string) => string | null;
}

export class DocumentContentEngine {
  constructor(private readonly options: DocumentContentEngineOptions = {}) {}

  normalizeDocument(
    content: TiptapJsonContent,
    documentId: string,
    roomId: string | null,
    indexedVersion = 0,
  ): NormalizedGatewayDocument {
    const scope = roomId ?? WORKSPACE_DOCUMENT_CHANNEL;
    if (hasEmbeddedDocumentImages(content)) {
      throw new DocumentServiceError(
        "EMBEDDED_IMAGE_NOT_ALLOWED",
        "Document images must be stored as local assets",
        400,
      );
    }
    const normalized = normalizeDocumentContent(content, documentId, scope, { indexedVersion });
    this.validateReferences(normalized.references, scope);
    return normalized;
  }

  normalizeFragment(
    content: TiptapJsonContent,
    documentId: string,
    roomId: string | null,
  ): NormalizedGatewayDocument {
    const scope = roomId ?? WORKSPACE_DOCUMENT_CHANNEL;
    const normalized = normalizeDocumentFragment(content, documentId, scope);
    this.validateReferences(normalized.references, scope);
    return normalized;
  }

  normalizeStoredDocument(
    content: TiptapJsonContent,
    documentId: string,
    roomId: string | null,
    fromSchemaVersion: number,
    indexedVersion = 0,
  ): NormalizedGatewayDocument {
    let migrated: ReturnType<typeof migrateDocumentContent>;
    try {
      migrated = migrateDocumentContent(content, fromSchemaVersion);
    } catch (error) {
      throw new DocumentServiceError(
        "UNSUPPORTED_DOCUMENT_SCHEMA",
        error instanceof Error ? error.message : "Document content schema cannot be migrated",
        409,
      );
    }
    const scope = roomId ?? WORKSPACE_DOCUMENT_CHANNEL;
    const normalized = normalizeDocumentContent(
      migrated.content,
      documentId,
      scope,
      { indexedVersion },
    );
    this.validateReferences(normalized.references, scope);
    return normalized;
  }

  private validateReferences(references: ProjectedDocumentReference[], roomId: string): void {
    for (const reference of references) {
      if (reference.targetRoomId !== roomId) {
        throw new DocumentServiceError(
          "CROSS_ROOM_REFERENCE",
          "Document block references must stay in one Room",
          409,
        );
      }
      const targetRoom = this.options.findDocumentRoom?.(reference.targetDocumentId);
      if (targetRoom && targetRoom !== roomId) {
        throw new DocumentServiceError(
          "CROSS_ROOM_REFERENCE",
          "Referenced document belongs to another Room",
          409,
        );
      }
    }
  }
}
