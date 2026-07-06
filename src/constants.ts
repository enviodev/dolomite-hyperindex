export const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";
// global oArb/goArb reward token addresses (from constants.template.ts), lowercased
export const OARB_TOKEN_ADDRESS = "0xcbed801b4162bf2a19b06968663438b5165a6a93";
export const GOARB_TOKEN_ADDRESS = "0xc5e16f5009776ab645d6719b72962892428b2ac2";

export type ChainConstants = {
  dolomiteMargin: string;
  expiry: string;
  factory: string;                 // dolomiteAmmFactoryAddress
  ammRouters: string[];            // [v1, v2] non-zero only
  borrowProxies: string[];         // [v1, v2] non-zero only
  genericTraders: string[];        // [v1, v2] non-zero only
  eventEmitter: string;
  eventEmitterFromCore: string;
  modularInterestSetter: string;
  aaveAltInterestSetter: string;
  aaveStableInterestSetter: string;
  alwaysZeroInterestSetter: string;
  doubleExponentInterestSetter: string;
  liquidityMiningClaimer: string;
  oArbVester: string;
  goArbVester: string;
  weth: string;
  usdc: string;
  usdt: string;
  dai: string;
  wbtc: string;
  link: string;
  arb: string;
  grai: string;
  matic: string;
  daiWethPair: string;             // wethDaiAddress
  usdtWethPair: string;            // wethUsdtAddress
  wethUsdc: string;                // wethUsdcAddress
  magicGlpUnwrapper: string;       // magicGlpUnwrapperTraderAddress
  magicGlpWrapper: string;         // magicGlpWrapperTraderAddress
  whitelist: string[];             // per constants.template.ts: ONLY arbitrum-one is non-empty: [weth, usdc, usdt, dai, wbtc, link]; all other chains []
};

export const CHAIN_CONSTANTS: Record<number, ChainConstants> = {
  // ethereum
  1: {
    dolomiteMargin: "0x003ca23fd5f0ca87d01f6ec6cd14a8ae60c2b97d",
    expiry: "0x2ae007882b91206942c70adc833a61ee531d8d5d",
    factory: "0x0000000000000000000000000000000000000000",
    ammRouters: [],
    borrowProxies: ["0x67567fce98a44745820069c37c395426f1c30ba6", "0xc06271eb97d960f4034ddf953e16271ccb2b10bd"],
    genericTraders: ["0xb50bcdfc914e0afb484dee621f49010862fb928d"],
    eventEmitter: "0x6d40138c99f6d9116f738f44a0e6751a42232486",
    eventEmitterFromCore: "0x12d6db1f1834658f01fc69a506f49bee424b38cc",
    modularInterestSetter: "0xe125c33e0190e7f2048d28188d53a1c23ace6029",
    aaveAltInterestSetter: "0xf8aaca0676f327a2ef7f0175e3fdc3681773622c",
    aaveStableInterestSetter: "0x38c26cf448ec324e9a8afc71f41945ca509d33cc",
    alwaysZeroInterestSetter: "0x9ecbbceb49c39a59d18b064b7049aac2d4d28ca2",
    doubleExponentInterestSetter: "0x23543d84cd9886abe74671351e6712625cb29e4b",
    liquidityMiningClaimer: "0x0000000000000000000000000000000000000000",
    oArbVester: "0x0000000000000000000000000000000000000000",
    goArbVester: "0x0000000000000000000000000000000000000000",
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    usdt: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    dai: "0x6b175474e89094c44da98b954eedeac495271d0f",
    wbtc: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    link: "0x514910771af9ca656af840dff83e8264ecf986ca",
    arb: "0x0000000000000000000000000000000000000000",
    grai: "0x0000000000000000000000000000000000000000",
    matic: "0x0000000000000000000000000000000000000000",
    daiWethPair: "0x0000000000000000000000000000000000000000",
    usdtWethPair: "0x0000000000000000000000000000000000000000",
    wethUsdc: "0x0000000000000000000000000000000000000000",
    magicGlpUnwrapper: "0x0000000000000000000000000000000000000000",
    magicGlpWrapper: "0x0000000000000000000000000000000000000000",
    whitelist: [],
  },
  // arbitrum-one
  42161: {
    dolomiteMargin: "0x6bd780e7fdf01d77e4d475c821f1e7ae05409072",
    expiry: "0xdec1ae3b570ac3c57871bbd7bfeacc807f973bea",
    factory: "0xd99c21c96103f36bc1fa26dd6448af4da030c1ef",
    ammRouters: ["0xa09b4a3fc92965e587a94539ee8b35ecf42d5a08", "0xd8f9c59176ae25414fc4180f6433fc45b0cbb632"],
    borrowProxies: ["0xe43638797513ef7a6d326a95e8647d86d2f5a099", "0x38e49a617305101216ec6306e3a18065d14bf3a7"],
    genericTraders: ["0x3e647e1242a8ce0ce013cb967fbff742d7846242", "0xe50c3118349f09abafc1bb01ad5cb946b1de83f6"],
    eventEmitter: "0x4bff12773b0dc3cb35f174b5cd351f662018cc2f",
    eventEmitterFromCore: "0x0000000000000000000000000000000000000000",
    modularInterestSetter: "0xe125c33e0190e7f2048d28188d53a1c23ace6029",
    aaveAltInterestSetter: "0xc2cbd99bb35b22c43010a8c8266cdff057f70bb1",
    aaveStableInterestSetter: "0xea4e670fd64ae82af5a3d77b3db6b5e28a5522de",
    alwaysZeroInterestSetter: "0x37b6ff70654edfbdaa3c9a723fdadf5844de2168",
    doubleExponentInterestSetter: "0xf74fdc3e515f05bd0c5f89fbf03f59a02cfdb37b",
    liquidityMiningClaimer: "0x66cd7d0cc677f42f6662622c60a5e60ef573db67",
    oArbVester: "0x531bc6e97b65adf8b3683240bd594932cfb63797",
    goArbVester: "0xec0f08bc015a0d0fba1df0b8b11d4779f5a04326",
    weth: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    usdc: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
    usdt: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
    dai: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",
    wbtc: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
    link: "0xf97f4df75117a78c1a5a0dbb814af92458539fb4",
    arb: "0x912ce59144191c1204e64559fe8253a0e49e6548",
    grai: "0x894134a25a5fac1c2c26f1d8fbf05111a3cb9487",
    matic: "0x0000000000000000000000000000000000000000",
    daiWethPair: "0xfb1d1115ac867acb7347638c4ccda4ac2122d1da",
    usdtWethPair: "0xca7b324e5a15ded8980bef68a91629fadf2ab171",
    wethUsdc: "0xb77a493a4950cad1b049e222d62bce14ff423c6f",
    magicGlpUnwrapper: "0x76a03ced39f0930777974906ee7e792bd25a29dd",
    magicGlpWrapper: "0x298a07c4a5b6bc32e1ef37bf5ccb3a17c106224d",
    whitelist: ["0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", "0xf97f4df75117a78c1a5a0dbb814af92458539fb4"],
  },
  // base
  8453: {
    dolomiteMargin: "0x003ca23fd5f0ca87d01f6ec6cd14a8ae60c2b97d",
    expiry: "0x2ae007882b91206942c70adc833a61ee531d8d5d",
    factory: "0x0000000000000000000000000000000000000000",
    ammRouters: [],
    borrowProxies: ["0x67567fce98a44745820069c37c395426f1c30ba6", "0xc06271eb97d960f4034ddf953e16271ccb2b10bd"],
    genericTraders: ["0xb50bcdfc914e0afb484dee621f49010862fb928d"],
    eventEmitter: "0x6d40138c99f6d9116f738f44a0e6751a42232486",
    eventEmitterFromCore: "0x12d6db1f1834658f01fc69a506f49bee424b38cc",
    modularInterestSetter: "0xe125c33e0190e7f2048d28188d53a1c23ace6029",
    aaveAltInterestSetter: "0xf8aaca0676f327a2ef7f0175e3fdc3681773622c",
    aaveStableInterestSetter: "0x38c26cf448ec324e9a8afc71f41945ca509d33cc",
    alwaysZeroInterestSetter: "0x9ecbbceb49c39a59d18b064b7049aac2d4d28ca2",
    doubleExponentInterestSetter: "0x23543d84cd9886abe74671351e6712625cb29e4b",
    liquidityMiningClaimer: "0x0000000000000000000000000000000000000000",
    oArbVester: "0x0000000000000000000000000000000000000000",
    goArbVester: "0x0000000000000000000000000000000000000000",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    usdt: "0x0000000000000000000000000000000000000000",
    dai: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
    wbtc: "0x0000000000000000000000000000000000000000",
    link: "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196",
    arb: "0x0000000000000000000000000000000000000000",
    grai: "0x0000000000000000000000000000000000000000",
    matic: "0x0000000000000000000000000000000000000000",
    daiWethPair: "0x0000000000000000000000000000000000000000",
    usdtWethPair: "0x0000000000000000000000000000000000000000",
    wethUsdc: "0x0000000000000000000000000000000000000000",
    magicGlpUnwrapper: "0x0000000000000000000000000000000000000000",
    magicGlpWrapper: "0x0000000000000000000000000000000000000000",
    whitelist: [],
  },
  // berachain-mainnet
  80094: {
    dolomiteMargin: "0x003ca23fd5f0ca87d01f6ec6cd14a8ae60c2b97d",
    expiry: "0x2ae007882b91206942c70adc833a61ee531d8d5d",
    factory: "0x0000000000000000000000000000000000000000",
    ammRouters: [],
    borrowProxies: ["0x67567fce98a44745820069c37c395426f1c30ba6", "0xc06271eb97d960f4034ddf953e16271ccb2b10bd"],
    genericTraders: ["0xb50bcdfc914e0afb484dee621f49010862fb928d"],
    eventEmitter: "0x6d40138c99f6d9116f738f44a0e6751a42232486",
    eventEmitterFromCore: "0x12d6db1f1834658f01fc69a506f49bee424b38cc",
    modularInterestSetter: "0xe125c33e0190e7f2048d28188d53a1c23ace6029",
    aaveAltInterestSetter: "0xf8aaca0676f327a2ef7f0175e3fdc3681773622c",
    aaveStableInterestSetter: "0x38c26cf448ec324e9a8afc71f41945ca509d33cc",
    alwaysZeroInterestSetter: "0x9ecbbceb49c39a59d18b064b7049aac2d4d28ca2",
    doubleExponentInterestSetter: "0x23543d84cd9886abe74671351e6712625cb29e4b",
    liquidityMiningClaimer: "0x0000000000000000000000000000000000000000",
    oArbVester: "0x0000000000000000000000000000000000000000",
    goArbVester: "0x0000000000000000000000000000000000000000",
    weth: "0x2f6f07cdcf3588944bf4c42ac74ff24bf56e7590",
    usdc: "0x549943e04f40284185054145c6e4e9568c1d3241",
    usdt: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    dai: "0x0000000000000000000000000000000000000000",
    wbtc: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
    link: "0x0000000000000000000000000000000000000000",
    arb: "0x0000000000000000000000000000000000000000",
    grai: "0x0000000000000000000000000000000000000000",
    matic: "0x0000000000000000000000000000000000000000",
    daiWethPair: "0x0000000000000000000000000000000000000000",
    usdtWethPair: "0x0000000000000000000000000000000000000000",
    wethUsdc: "0x0000000000000000000000000000000000000000",
    magicGlpUnwrapper: "0x0000000000000000000000000000000000000000",
    magicGlpWrapper: "0x0000000000000000000000000000000000000000",
    whitelist: [],
  },
  // bsc
  56: {
    dolomiteMargin: "0x003ca23fd5f0ca87d01f6ec6cd14a8ae60c2b97d",
    expiry: "0x2ae007882b91206942c70adc833a61ee531d8d5d",
    factory: "0x0000000000000000000000000000000000000000",
    ammRouters: [],
    borrowProxies: ["0x67567fce98a44745820069c37c395426f1c30ba6", "0xc06271eb97d960f4034ddf953e16271ccb2b10bd"],
    genericTraders: ["0xb50bcdfc914e0afb484dee621f49010862fb928d"],
    eventEmitter: "0x6d40138c99f6d9116f738f44a0e6751a42232486",
    eventEmitterFromCore: "0x12d6db1f1834658f01fc69a506f49bee424b38cc",
    modularInterestSetter: "0xe125c33e0190e7f2048d28188d53a1c23ace6029",
    aaveAltInterestSetter: "0xf8aaca0676f327a2ef7f0175e3fdc3681773622c",
    aaveStableInterestSetter: "0x38c26cf448ec324e9a8afc71f41945ca509d33cc",
    alwaysZeroInterestSetter: "0x9ecbbceb49c39a59d18b064b7049aac2d4d28ca2",
    doubleExponentInterestSetter: "0x23543d84cd9886abe74671351e6712625cb29e4b",
    liquidityMiningClaimer: "0x0000000000000000000000000000000000000000",
    oArbVester: "0x0000000000000000000000000000000000000000",
    goArbVester: "0x0000000000000000000000000000000000000000",
    weth: "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    usdc: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    usdt: "0x55d398326f99059ff775485246999027b3197955",
    dai: "0x0000000000000000000000000000000000000000",
    wbtc: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
    link: "0x0000000000000000000000000000000000000000",
    arb: "0x0000000000000000000000000000000000000000",
    grai: "0x0000000000000000000000000000000000000000",
    matic: "0x0000000000000000000000000000000000000000",
    daiWethPair: "0x0000000000000000000000000000000000000000",
    usdtWethPair: "0x0000000000000000000000000000000000000000",
    wethUsdc: "0x0000000000000000000000000000000000000000",
    magicGlpUnwrapper: "0x0000000000000000000000000000000000000000",
    magicGlpWrapper: "0x0000000000000000000000000000000000000000",
    whitelist: [],
  },
  // mantle
  5000: {
    dolomiteMargin: "0xe6ef4f0b2455bab92ce7cc78e35324ab58917de8",
    expiry: "0x6df6dbf5053c3771217376fb3ef7f1f5d4889a25",
    factory: "0x0000000000000000000000000000000000000000",
    ammRouters: [],
    borrowProxies: ["0x97a08604a56f16947a4a956efec2ef223364b733", "0xe99a7e4556caf7925fbac52765128e524e9dd793"],
    genericTraders: ["0x8a13c00facd1971fbb7ced5ebf88f9e900419d5c"],
    eventEmitter: "0x778cea4ce43ba1a3ed6306ca692b8d9d3dfb827c",
    eventEmitterFromCore: "0x2fdb2bfb1f5926e9996fd86fe5e0782b126f8785",
    modularInterestSetter: "0xe125c33e0190e7f2048d28188d53a1c23ace6029",
    aaveAltInterestSetter: "0x10114c4d4c6d55474b9c20cdbf622b3c8806e745",
    aaveStableInterestSetter: "0xaa652e0e6fd880dcbc217847bfd1a58c249bdf63",
    alwaysZeroInterestSetter: "0x3f0269aac5d3fa3cd518d9e809f45458c1504923",
    doubleExponentInterestSetter: "0xdb70d853618bdabd6742bef2a03da7d704aa687c",
    liquidityMiningClaimer: "0x0000000000000000000000000000000000000000",
    oArbVester: "0x0000000000000000000000000000000000000000",
    goArbVester: "0x0000000000000000000000000000000000000000",
    weth: "0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111",
    usdc: "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9",
    usdt: "0x201eba5cc46d216ce6dc03f6a759e8e766e956ae",
    dai: "0x0000000000000000000000000000000000000000",
    wbtc: "0xcabae6f6ea1ecab08ad02fe02ce9a44f09aebfa2",
    link: "0x0000000000000000000000000000000000000000",
    arb: "0x0000000000000000000000000000000000000000",
    grai: "0x0000000000000000000000000000000000000000",
    matic: "0x0000000000000000000000000000000000000000",
    daiWethPair: "0x0000000000000000000000000000000000000000",
    usdtWethPair: "0x0000000000000000000000000000000000000000",
    wethUsdc: "0x0000000000000000000000000000000000000000",
    magicGlpUnwrapper: "0x0000000000000000000000000000000000000000",
    magicGlpWrapper: "0x0000000000000000000000000000000000000000",
    whitelist: [],
  },
  // polygon-zkevm
  1101: {
    dolomiteMargin: "0x836b557cf9ef29fcf49c776841191782df34e4e5",
    expiry: "0xb3f81b0f53cdee755c70665923e08a8f0e81d0c3",
    factory: "0x0000000000000000000000000000000000000000",
    ammRouters: [],
    borrowProxies: ["0xc28a4ec9f09e4071e3707eaaca5c3754fa4f5faa", "0xb3ff983d7927540b7f92602657a2a26977664e77"],
    genericTraders: ["0x660bd80f67aa9c7bfb82933e1068f8f616d88255"],
    eventEmitter: "0x2e9be819d04cb62bf3816b627c9dff819136cec4",
    eventEmitterFromCore: "0xb4f0eb9c8fb5fbabef339f8738173db645c4147d",
    modularInterestSetter: "0xe125c33e0190e7f2048d28188d53a1c23ace6029",
    aaveAltInterestSetter: "0x86cfc6ba3bbbc603b8dec5b032afa10a3592470d",
    aaveStableInterestSetter: "0xee34b48a6fc757386763409183bbab704a0b22e6",
    alwaysZeroInterestSetter: "0xc90e5df165c26441f6f4e558ca6128a42eb95787",
    doubleExponentInterestSetter: "0xfc280671d79b02086dd59c89f69632040d366ea8",
    liquidityMiningClaimer: "0x0000000000000000000000000000000000000000",
    oArbVester: "0x0000000000000000000000000000000000000000",
    goArbVester: "0x0000000000000000000000000000000000000000",
    weth: "0x4f9a0e7fd2bf6067db6994cf12e4495df938e6e9",
    usdc: "0x37eaa0ef3549a5bb7d431be78a3d99bd360d19e5",
    usdt: "0x1e4a5963abfd975d8c9021ce480b42188849d41d",
    dai: "0xc5015b9d9161dca7e18e32f6f25c4ad850731fd4",
    wbtc: "0xea034fb02eb1808c2cc3adbc15f447b93cbe08e1",
    link: "0x4b16e4752711a7abec32799c976f3cefc0111f2b",
    arb: "0x0000000000000000000000000000000000000000",
    grai: "0x0000000000000000000000000000000000000000",
    matic: "0xa2036f0538221a77a3937f1379699f44945018d0",
    daiWethPair: "0x0000000000000000000000000000000000000000",
    usdtWethPair: "0x0000000000000000000000000000000000000000",
    wethUsdc: "0x0000000000000000000000000000000000000000",
    magicGlpUnwrapper: "0x0000000000000000000000000000000000000000",
    magicGlpWrapper: "0x0000000000000000000000000000000000000000",
    whitelist: [],
  },
  // x-layer
  196: {
    dolomiteMargin: "0x836b557cf9ef29fcf49c776841191782df34e4e5",
    expiry: "0x8b808a1feef1d9cdd00fb46a19e4814e5646197c",
    factory: "0x0000000000000000000000000000000000000000",
    ammRouters: [],
    borrowProxies: ["0xb4f0eb9c8fb5fbabef339f8738173db645c4147d", "0x694f7ba53e331d8494043a41262dc063b0f5c8b4"],
    genericTraders: ["0xe355df372c4faaedf895b958de5d7fb89215aeea"],
    eventEmitter: "0xd86233e2e53a87f0735c5643f3189cfec07269bf",
    eventEmitterFromCore: "0x0a512510438bd340c59a000e997709eedc0b7589",
    modularInterestSetter: "0xe125c33e0190e7f2048d28188d53a1c23ace6029",
    aaveAltInterestSetter: "0xc90e5df165c26441f6f4e558ca6128a42eb95787",
    aaveStableInterestSetter: "0xfc280671d79b02086dd59c89f69632040d366ea8",
    alwaysZeroInterestSetter: "0xa5f4ceb032a1d7c711bb8ae687f9ab13a976e2e9",
    doubleExponentInterestSetter: "0xd55afc5ee5ffdad3d44829b22e2c2b10a484d33e",
    liquidityMiningClaimer: "0x0000000000000000000000000000000000000000",
    oArbVester: "0x0000000000000000000000000000000000000000",
    goArbVester: "0x0000000000000000000000000000000000000000",
    weth: "0x5a77f1443d16ee5761d310e38b62f77f726bc71c",
    usdc: "0x74b7f16337b8972027f6196a17a631ac6de26d22",
    usdt: "0x1e4a5963abfd975d8c9021ce480b42188849d41d",
    dai: "0xc5015b9d9161dca7e18e32f6f25c4ad850731fd4",
    wbtc: "0xea034fb02eb1808c2cc3adbc15f447b93cbe08e1",
    link: "0x0000000000000000000000000000000000000000",
    arb: "0x0000000000000000000000000000000000000000",
    grai: "0x0000000000000000000000000000000000000000",
    matic: "0x0000000000000000000000000000000000000000",
    daiWethPair: "0x0000000000000000000000000000000000000000",
    usdtWethPair: "0x0000000000000000000000000000000000000000",
    wethUsdc: "0x0000000000000000000000000000000000000000",
    magicGlpUnwrapper: "0x0000000000000000000000000000000000000000",
    magicGlpWrapper: "0x0000000000000000000000000000000000000000",
    whitelist: [],
  },
};

export function getConstants(chainId: number): ChainConstants {
  const c = CHAIN_CONSTANTS[chainId];
  if (!c) throw new Error(`No constants configured for chain ${chainId}`);
  return c;
}
