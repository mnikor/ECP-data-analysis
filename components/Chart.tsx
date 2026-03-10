import React, { useEffect, useRef } from 'react';

declare global {
  interface Window {
    Plotly: any;
  }
}

interface ChartProps {
  data: any[];
  layout: any;
  className?: string;
}

export const Chart: React.FC<ChartProps> = ({ data, layout, className = 'h-[28rem]' }) => {
  const plotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const plotNode = plotRef.current;
    if (!window.Plotly || !plotNode) return;

    const responsiveLayout = {
      ...layout,
      autosize: true,
      paper_bgcolor: layout.paper_bgcolor || '#ffffff',
      plot_bgcolor: layout.plot_bgcolor || '#ffffff',
      margin: { l: 70, r: 24, t: 56, b: 72, ...layout.margin },
    };

    const config = {
      responsive: true,
      displayModeBar: false,
      displaylogo: false,
    };

    window.Plotly.react(plotNode, data, responsiveLayout, config);

    const resizePlot = () => {
      if (plotNode) {
        window.Plotly.Plots.resize(plotNode);
      }
    };

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resizePlot) : null;
    if (resizeObserver) resizeObserver.observe(plotNode);
    window.addEventListener('resize', resizePlot);

    return () => {
      window.removeEventListener('resize', resizePlot);
      resizeObserver?.disconnect();
      if (plotNode) {
        window.Plotly.purge(plotNode);
      }
    };
  }, [data, layout]);

  return <div ref={plotRef} className={`w-full bg-white rounded-xl border border-slate-200 shadow-sm ${className}`} />;
};
