import { createContext, useContext } from "react";

/**
 * Models hidden in orc settings. App reads them with a single poll and hands them to forms via
 * context: otherwise the list would have to be threaded through props into every window with a model choice.
 * The project list (Project.hidden_models) lives in the project itself — see effectiveHiddenModels.
 */
export const AppHiddenModelsContext = createContext<readonly string[]>([]);

export const useAppHiddenModels = () => useContext(AppHiddenModelsContext);
