const html = require('rollup-plugin-html');
const typescript = require('rollup-plugin-typescript2');
const { terser } = require("rollup-plugin-terser");
const multiEntry = require("rollup-plugin-multi-entry");
const resolve = require("rollup-plugin-node-resolve");
const commonjs = require('rollup-plugin-commonjs');
const fs = require('fs');
const jscodeshift = require('jscodeshift');

const makeCS = require('./rollup-plugin-make-cs');

require('ts-node').register({ /* options */ })
const split = require('./transforms/split');

const PROD = process.env.NODE_ENV === 'production';
const PLANS = [0, 10, 20];
const PLANS_AND_PARTS = ['backend', ...[].concat.apply([], ['matching.cs', 'nonmatching.cs'].map(cs => PLANS.map(plan => `${plan}.${cs}`)))];

function versionConvertDots(v) {
	return v.replace(/\./g, '-')
}

module.exports = async function getConfig(finalOutputDir, pluginNames) {
	return (await Promise.all(pluginNames.map(async pluginName => {
		// const pluginVersion = babelParser.parse(`src/${pluginName}/${pluginName}.ts`, {
		// 	sourceType: 'module',
		// 	plugins: [
		// 		'typescript',
		// 	],
		// });
		// const mainPath = `src/${pluginName}/${pluginName}.ts`;
		// const src = fs.readFileSync(mainPath).toString();
		// const parsedPlugin = new ParsedPlugin(JSCodeShift, src);
		// const version = parsedPlugin.getVersion();
		// console.log(version);
		// debugger;
		// return;
		const version = versionConvertDots('2.7.2');
		return [{
			input: [
				`src/${pluginName}/${pluginName}.ts`,
				`src/${pluginName}/${pluginName}.*.ts`,
			],
			treeshake: false,
			plugins: [
				multiEntry(),
				resolve({
					preferBuiltins: false,
				}),
				commonjs(),
				typescript(),
			],
			output: {
				// garbage since we use jscodeshift on the cmd line
				file: `dist/tmp/${pluginName}.joined.mjs`,
				format: 'esm',
			}
		},
		{
			input: `dist/tmp/${pluginName}.joined.mjs`,
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
								const src = fs.readFileSync(`dist/tmp/${pluginName}.joined.mjs`).toString();
								const ret = split(jscodeshift, PLANS, src);
								const version = ret.version;
								let i = 0;

								for (let planAndPart of PLANS_AND_PARTS) {
									const source = ret.byPlan[i];
									i++
									try {
										const fullName = `${pluginName}.${versionConvertDots(version)}.${planAndPart}.js`;
										bundle[fullName] = {
											isAsset: true,
											fileName: fullName,
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
				dir: 'dist/tmp',
				format: 'esm',
			}
		},
		// to prevent chunking external deps, do the files one by one :( (rollup shortcoming)
		// hack: manually including version
		...PLANS_AND_PARTS.map(planAndPart => `dist/tmp/${pluginName}.${version}.${planAndPart}.js`).map(filename => ({
			// don't use globby.sync because it resolves before files are ready
			input: filename,
			treeshake: {
				moduleSideEffects: false,
				pureExternalModules: true,
			},
			plugins: [
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
			input: PLANS_AND_PARTS.map(planAndPart => `dist/tmp/${pluginName}.${version}.${planAndPart}.resolved.js`),
			plugins: [
				makeCS(),
			],
			output: {
				format: 'esm',
				dir: finalOutputDir,
			}
		}
	];
	}
	))).flat();
}
