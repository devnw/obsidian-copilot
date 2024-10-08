import { extractNoteTitles, getNoteFileFromTitle } from "@/utils";
import VectorDBManager from "@/vectorDBManager";
import { BaseCallbackConfig } from "@langchain/core/callbacks/manager";
import { Document } from "@langchain/core/documents";
import { Embeddings } from "@langchain/core/embeddings";
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { BaseRetriever } from "@langchain/core/retrievers";
import { Orama, search } from "@orama/orama";
import { Vault } from "obsidian";

export class HybridRetriever extends BaseRetriever {
  public lc_namespace = ["hybrid_retriever"];

  private llm: BaseLanguageModel;
  private queryRewritePrompt: ChatPromptTemplate;
  private embeddingsInstance: Embeddings;
  constructor(
    private db: Orama<any>,
    private vault: Vault,
    llm: BaseLanguageModel,
    embeddingsInstance: Embeddings,
    private options: {
      minSimilarityScore: number;
      maxK: number;
    },
    private debug?: boolean
  ) {
    super();
    this.llm = llm;
    this.embeddingsInstance = embeddingsInstance;
    this.queryRewritePrompt = ChatPromptTemplate.fromTemplate(
      "Please write a passage to answer the question. If you don't know the answer, just make up a passage. \nQuestion: {question}\nPassage:"
    );
  }

  async getRelevantDocuments(query: string, config?: BaseCallbackConfig): Promise<Document[]> {
    // Extract note titles wrapped in [[]] from the query
    const noteTitles = extractNoteTitles(query);
    // Retrieve chunks for explicitly mentioned note titles
    const explicitChunks = await this.getExplicitChunks(noteTitles);
    let rewrittenQuery = query;
    if (config?.runName !== "no_hyde") {
      // Use config to determine if HyDE should be used
      // Generate a hypothetical answer passage
      rewrittenQuery = await this.rewriteQuery(query);
    }
    // Perform vector similarity search using ScoreThresholdRetriever
    const oramaChunks = await this.getOramaChunks(rewrittenQuery);

    // Combine explicit and vector chunks, removing duplicates while maintaining order
    const uniqueChunks = new Set<string>(explicitChunks.map((chunk) => chunk.pageContent));
    const combinedChunks: Document[] = [...explicitChunks];

    for (const chunk of oramaChunks) {
      const chunkContent = chunk.pageContent;
      if (!uniqueChunks.has(chunkContent)) {
        uniqueChunks.add(chunkContent);
        combinedChunks.push(chunk);
      }
    }

    if (this.debug) {
      console.log("*** HYBRID RETRIEVER DEBUG INFO: ***");

      if (config?.runName !== "no_hyde") {
        console.log("\nOriginal Query: ", query);
        console.log("\nRewritten Query: ", rewrittenQuery);
      }

      console.log(
        "\nNote Titles extracted: ",
        noteTitles,
        "\n\nExplicit Chunks:",
        explicitChunks,
        "\n\nOrama Chunks:",
        oramaChunks,
        "\n\nCombined Chunks:",
        combinedChunks
      );
    }

    // Make sure the combined chunks are at most maxK
    return combinedChunks.slice(0, this.options.maxK);
  }

  private async rewriteQuery(query: string): Promise<string> {
    try {
      const promptResult = await this.queryRewritePrompt.format({ question: query });
      const rewrittenQueryObject = await this.llm.invoke(promptResult);

      // Directly return the content assuming it's structured as expected
      if (rewrittenQueryObject && "content" in rewrittenQueryObject) {
        return rewrittenQueryObject.content;
      }
      console.warn("Unexpected rewrittenQuery format. Falling back to original query.");
      return query;
    } catch (error) {
      console.error("Error in rewriteQuery:", error);
      // If there's an error, return the original query
      return query;
    }
  }

  private async getExplicitChunks(noteTitles: string[]): Promise<Document[]> {
    const explicitChunks: Document[] = [];
    for (const noteTitle of noteTitles) {
      const noteFile = await getNoteFileFromTitle(this.vault, noteTitle);
      const hits = await VectorDBManager.getDocsByPath(this.db, noteFile?.path ?? "");
      if (hits) {
        const matchingChunks = hits.map(
          (hit: any) =>
            new Document({
              pageContent: hit.document.content,
              metadata: {
                ...hit.document.metadata,
                score: hit.score,
                path: hit.document.path,
                mtime: hit.document.mtime,
                ctime: hit.document.ctime,
                title: hit.document.title,
                id: hit.document.id,
                embeddingModel: hit.document.embeddingModel,
                tags: hit.document.tags,
                extension: hit.document.extension,
                created_at: hit.document.created_at,
                nchars: hit.document.nchars,
              },
            })
        );
        explicitChunks.push(...matchingChunks);
      }
    }
    return explicitChunks;
  }

  private async getOramaChunks(query: string): Promise<Document[]> {
    let queryVector: number[];
    try {
      queryVector = await this.convertQueryToVector(query);
    } catch (error) {
      console.error(
        "Error in convertQueryToVector, please ensure your embedding model is working and has an adequate context length:",
        error,
        "\nQuery:",
        query
      );
      throw error;
    }

    const searchResults = await search(this.db, {
      mode: "vector",
      vector: {
        value: queryVector,
        property: "embedding",
      },
      similarity: this.options.minSimilarityScore,
      limit: this.options.maxK,
      includeVectors: true,
    });

    // Convert Orama search results to Document objects
    const vectorChunks = searchResults.hits.map(
      (hit) =>
        new Document({
          pageContent: hit.document.content,
          metadata: {
            ...hit.document.metadata,
            score: hit.score,
            path: hit.document.path,
            mtime: hit.document.mtime,
            ctime: hit.document.ctime,
            title: hit.document.title,
            id: hit.document.id,
            embeddingModel: hit.document.embeddingModel,
            tags: hit.document.tags,
            extension: hit.document.extension,
            created_at: hit.document.created_at,
            nchars: hit.document.nchars,
          },
        })
    );
    return vectorChunks;
  }

  private async convertQueryToVector(query: string): Promise<number[]> {
    return await this.embeddingsInstance.embedQuery(query);
  }
}
