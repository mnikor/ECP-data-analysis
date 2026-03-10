import React from 'react';

interface BrandLogoProps {
  variant?: 'sidebar' | 'stacked' | 'horizontal';
  subtitle?: boolean;
  tone?: 'default' | 'inverse';
  className?: string;
}

const logoWidths: Record<NonNullable<BrandLogoProps['variant']>, string> = {
  sidebar: 'w-[180px] max-w-full',
  stacked: 'w-[520px] max-w-full',
  horizontal: 'w-[300px] max-w-full',
};

export const BrandLogo: React.FC<BrandLogoProps> = ({
  variant = 'horizontal',
  className = '',
}) => {
  return (
    <img
      src="/ECP%20Logo.png"
      alt="Evidence CoPilot"
      className={`${logoWidths[variant]} h-auto object-contain ${className}`}
    />
  );
};
