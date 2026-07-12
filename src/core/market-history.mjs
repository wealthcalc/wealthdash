/* ======================================================================
   LONG MARKET HISTORY — 100 years of annual (equity total return,
   inflation) pairs for the sequence-risk heatmap's rolling windows.

   PROVENANCE (fetched and transcribed 2026-07-12, not recalled from
   memory — same "verified by hand" rule as the DMO/HPI endpoints):
   - Equity: S&P 500 TOTAL returns (price + reinvested dividends) by
     calendar year, 1926–2025, from slickcharts.com/sp500/returns
     (their series: S&P 90 pre-1957). Partial current-year figure
     deliberately excluded.
   - Inflation: US CPI-U annual rates, 1926–2025, from
     slickcharts.com/inflation (BLS CPI, seasonally unadjusted).

   Honesty notes, stated once here and echoed in the UI:
   - This is a US equity series with US inflation. No equally long, freely
     tabulated UK series exists to bake in; for a GBP investor the levels
     differ but the PHENOMENON the heatmap tests — inflation shocks and
     crashes arriving early in retirement — is the same, and 1970s UK
     inflation was WORSE than the US series shown. Treat absolute success
     rates as indicative, orderings between start years as meaningful.
   - 100% equity: no bond damping. A real portfolio's path would be
     smoother; the heatmap shows the undamped sequence risk.
   ====================================================================== */

// year: [equity total return %, CPI inflation %]
export const MARKET_HISTORY = {
  1926: [11.62, -1.12], 1927: [37.49, -2.26], 1928: [43.61, -1.16], 1929: [-8.42, 0.58],
  1930: [-24.90, -6.40], 1931: [-43.34, -9.32], 1932: [-8.19, -10.27], 1933: [53.99, 0.76],
  1934: [-1.44, 1.52], 1935: [47.67, 2.99], 1936: [33.92, 1.45], 1937: [-35.03, 2.86],
  1938: [31.12, -2.78], 1939: [-0.41, 0.00], 1940: [-9.78, 0.71], 1941: [-11.59, 9.93],
  1942: [20.34, 9.03], 1943: [25.90, 2.96], 1944: [19.75, 2.30], 1945: [36.44, 2.25],
  1946: [-8.07, 18.13], 1947: [5.71, 8.84], 1948: [5.50, 2.99], 1949: [18.79, -2.07],
  1950: [31.71, 5.93], 1951: [24.02, 6.00], 1952: [18.37, 0.75], 1953: [-0.99, 0.75],
  1954: [52.62, -0.74], 1955: [31.56, 0.37], 1956: [6.56, 2.99], 1957: [-10.78, 2.90],
  1958: [43.36, 1.76], 1959: [11.96, 1.73], 1960: [0.47, 1.36], 1961: [26.89, 0.67],
  1962: [-8.73, 1.33], 1963: [22.80, 1.64], 1964: [16.48, 0.97], 1965: [12.45, 1.92],
  1966: [-10.06, 3.46], 1967: [23.98, 3.04], 1968: [11.06, 4.72], 1969: [-8.50, 6.20],
  1970: [4.01, 5.57], 1971: [14.31, 3.27], 1972: [18.98, 3.41], 1973: [-14.66, 8.71],
  1974: [-26.47, 12.34], 1975: [37.20, 6.94], 1976: [23.84, 4.86], 1977: [-7.18, 6.70],
  1978: [6.56, 9.02], 1979: [18.44, 13.29], 1980: [32.42, 12.52], 1981: [-4.91, 8.92],
  1982: [21.55, 3.83], 1983: [22.56, 3.79], 1984: [6.27, 3.95], 1985: [31.73, 3.80],
  1986: [18.67, 1.10], 1987: [5.25, 4.43], 1988: [16.61, 4.42], 1989: [31.69, 4.65],
  1990: [-3.10, 6.11], 1991: [30.47, 3.06], 1992: [7.62, 2.90], 1993: [10.08, 2.75],
  1994: [1.32, 2.67], 1995: [37.58, 2.54], 1996: [22.96, 3.32], 1997: [33.36, 1.70],
  1998: [28.58, 1.61], 1999: [21.04, 2.68], 2000: [-9.10, 3.39], 2001: [-11.89, 1.55],
  2002: [-22.10, 2.38], 2003: [28.68, 1.88], 2004: [10.88, 3.26], 2005: [4.91, 3.42],
  2006: [15.79, 2.54], 2007: [5.49, 4.08], 2008: [-37.00, 0.09], 2009: [26.46, 2.72],
  2010: [15.06, 1.50], 2011: [2.11, 2.96], 2012: [16.00, 1.74], 2013: [32.39, 1.50],
  2014: [13.69, 0.76], 2015: [1.38, 0.73], 2016: [11.96, 2.07], 2017: [21.83, 2.11],
  2018: [-4.38, 1.91], 2019: [31.49, 2.29], 2020: [18.40, 1.36], 2021: [28.71, 7.04],
  2022: [-18.11, 6.45], 2023: [26.29, 3.35], 2024: [25.02, 2.89], 2025: [17.88, 2.68],
};

export const HISTORY_YEARS = Object.keys(MARKET_HISTORY).map(Number).sort((a, b) => a - b);
export const HISTORY_FROM = HISTORY_YEARS[0];
export const HISTORY_TO = HISTORY_YEARS[HISTORY_YEARS.length - 1];

// Ordered [{ year, ret, infl }] — the shape the replay engines consume.
export function historyPairs() {
  return HISTORY_YEARS.map((y) => ({ year: y, ret: MARKET_HISTORY[y][0], infl: MARKET_HISTORY[y][1] }));
}
