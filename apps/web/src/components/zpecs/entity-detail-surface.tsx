import { createContext, type ReactNode, useContext } from "react";

export type EntityDetailSurface = "drawer" | "page";

const EntityDetailSurfaceContext = createContext<EntityDetailSurface>("drawer");

export function EntityDetailSurfaceProvider({
  surface,
  children,
}: {
  surface: EntityDetailSurface;
  children: ReactNode;
}) {
  return (
    <EntityDetailSurfaceContext.Provider value={surface}>
      {children}
    </EntityDetailSurfaceContext.Provider>
  );
}

export function useEntityDetailSurface() {
  return useContext(EntityDetailSurfaceContext);
}
