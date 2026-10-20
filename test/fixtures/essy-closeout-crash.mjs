import {closeoutEssy} from '../../src/essy-closeout.mjs';

await closeoutEssy({
  factoryRoot:process.argv[2],
  episode:'ESSY-0006',
  url:'https://youtu.be/abcdefghijk',
  testHooks:{afterStage:() => process.exit(47)},
});
