const html = require('rollup-plugin-html');
const typescript = require('rollup-plugin-typescript2');
const { terser } = require("rollup-plugin-terser");
const multiEntry = require("rollup-plugin-multi-entry");
const resolve = require("rollup-plugin-node-resolve");
const globby = require('globby');
const commonjs = require('rollup-plugin-commonjs');
const fs = require('fs');
const JSCodeShift = require('jscodeshift').run;

const makeCS = require('./rollup-plugin-make-cs');

const PROD = process.env.NODE_ENV === 'production';
const FOLDER_REGX = /^src\/(.*)\/.*$/;
const PLANS = ['0', '10', '20'];
const PLANS_AND_PARTS = ['backend', ...[].concat.apply([], ['matching.cs', 'nonmatching.cs'].map(cs => PLANS.map(plan => `${plan}.${cs}`)))];

module.exports = [].concat(...globby.sync(['src/*/*.ts', '!src/*/tests.ts', '!src/@types', '!src/*/*.*.ts']).map(fileName => {
	console.log('doing ' + fileName)
	let regxRes = FOLDER_REGX.exec(fileName);
	let folderName = regxRes ? regxRes[1] : null;
	if (folderName) {
		return [
			{
				input: `src/${folderName}/*.ts`,
				treeshake: false,
				plugins: [
					typescript(),
					multiEntry(),
				],
				output: {
					// garbage since we use jscodeshift on the cmd line
					file: `dist/tmp/${folderName}.joined.mjs`,
					format: 'esm',
				}
			},
			{
				input: `dist/tmp/${folderName}.joined.mjs`,
				treeshake: false,
				plugins: [
					{
						/**
						 * Trim down for matching and non-matching URL frontend CS
						 */
						generateBundle(options, bundle, isWrite) {
							if (isWrite) {
								// async/await syntax messes shiz up
								return new Promise(async cb => {
									// make this the node_modules path instead
									let res = await JSCodeShift('/home/mikob/workspace/lipsurf/lipsurf-cli/transforms/split.ts', [`dist/tmp/${folderName}.joined.mjs`], {
										transform: './node_modules/lipsurf-cli/transforms/split.ts',
										verbose: 2,
										runInBand: true,

										dry: false,
										print: false,
										babel: true,
										extensions: 'js,mjs',
										ignorePattern: [],
										ignoreConfig: [],
										silent: false,
										parser: 'babel',
										stdin: false
									});
									
									for (let planAndPart of PLANS_AND_PARTS) {
										const pattern = `dist/tmp/${folderName}.*.${planAndPart}.js`;
										const fileParts = globby.sync(pattern);
										if (fileParts.length !== 1) {
											console.error(`Not exactly one file for ${folderName}`);
											console.log(fileParts);
											return;
										}
										const filePartName = fileParts[0].split('dist/tmp/')[1];
										try {
											const source = await fs.readFileSync(`dist/tmp/${filePartName}`);
											bundle[filePartName] = {
												isAsset: true,
												fileName: filePartName,
												source,
											};
										} catch (e) {
											if (e.code !== 'ENOENT')
												console.log(`${filePartName} problem`, e);
										}
									}
									cb();
								});
							}
						}
					}
				],
				output: {
					// garbage since we use jscodeshift on the cmd line
					file: `/tmp/${folderName}.garbage.js`,
					format: 'esm',
				}
			},
			// to prevent chunking external deps, do the files one by one :( (rollup shortcoming)
			// hack: manually including version
			...PLANS_AND_PARTS.map(planAndPart => `dist/tmp/${folderName}.2-0-0.${planAndPart}.js`).map(filename => ({
				// don't use globby.sync because it resolves before files are ready
				input: filename,
				treeshake: {
					moduleSideEffects: false,
					pureExternalModules: true,
				},
				plugins: [
					resolve(),
					commonjs(),
					html({
						include: '**/*.html',
						htmlMinifierOptions: {
							collapseWhitespace: true,
							collapseBooleanAttributes: true,
							conservativeCollapse: true,
							minifyJS: true,
							minifyCSS: true,
							removeComments: true,
						}
					}),
					PROD && terser({
						mangle: false,
						compress: {
							pure_funcs: [
								'console.log',
								'console.dir',
							]
						}
					}),
				],
				output: {
					format: 'esm',
					file: `${filename.split('.js')[0]}.resolved.js`
				}
			})),
			{
				// hack, manually including version in the input file name
				input: PLANS_AND_PARTS.map(planAndPart => `dist/tmp/${folderName}.2-0-0.${planAndPart}.resolved.js`),
				plugins: [
					makeCS(),
				],
				output: {
					format: 'esm',
					dir: 'dist',
				}
			}
		];
	}
}).filter(a => a));
