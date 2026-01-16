import React from 'react';
import * as HeroUI from '@heroui/react';

type ProviderProps = {
  children: React.ReactNode;
};

const provider = HeroUI as unknown as {
  HeroUIProvider?: React.ComponentType<ProviderProps>;
  NextUIProvider?: React.ComponentType<ProviderProps>;
};

const ProviderComponent = provider.HeroUIProvider ?? provider.NextUIProvider ?? React.Fragment;

export const UIProvider = ({ children }: ProviderProps) => {
  return <ProviderComponent>{children}</ProviderComponent>;
};
