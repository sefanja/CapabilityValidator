const NAME = 'CapabilityValidator';
const OUTPUT = 'output';
const AMPERSAND = 'ampersand';
const MODEL_FILE = 'model.adl';
const RULES_FILE = 'rules.adl';
const STANDALONE_FILE = 'standalone.adl';
const LEVEL = 'Level';
const MAX_LEVEL = 4;
const SUPPORTED_LEVELS = [...Array(MAX_LEVEL + 1).keys()].map(String);

function escapeText(text) {
    return text ? text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : '';
}

/**
 * Transforms elements and relationships to Ampersand format.
 */
function getModelContent(elements, relationships) {
    function toAmpersandType(s) {
        if (s.endsWith('-relationship')) return s.split('-')[0];
        return s.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
    }

    const lines = [];

    // Add header
    lines.push('CONTEXT Model');

    // Add element names
    const elementTypes = [...new Set(elements.map(e => e.type))];
    elementTypes.forEach(type => {
        const population = elements.filter(e => e.type === type)
            .map(e => `    ( "${e.id}" , "${escapeText(e.name)}" )`);
        lines.push(`RELATION name [${toAmpersandType(type)}*Text] [UNI]`);
        lines.push(`POPULATION name [${toAmpersandType(type)}*Text] CONTAINS [`);
        lines.push(population.join(',\n'));
        lines.push(`]\n`);
    });

    // Add element levels
    elementTypes.forEach(type => {
        const population = elements.filter(e => e.type === type)
            .flatMap(e => (e.prop(LEVEL, true) || []).map(level => `    ( "${e.id}" , "${escapeText(level)}" )`));
        lines.push(`RELATION level [${toAmpersandType(type)}*Level]`);
        lines.push(`POPULATION level [${toAmpersandType(type)}*Level] CONTAINS [`);
        lines.push(population.join(',\n'));
        lines.push(`]\n`);
    });

    // Add relationships
    const relationshipTypes = [...new Set(relationships.map(r => `${r.type}:${r.source.type}:${r.target.type}`))];
    relationshipTypes.forEach(complexType => {
        const [relType, sourceType, targetType] = complexType.split(':');
        const population = relationships.filter(r => r.type === relType && r.source.type === sourceType && r.target.type === targetType)
            .map(r => `    ( "${r.source.id}" , "${r.target.id}" )`);
        lines.push(`RELATION ${toAmpersandType(relType)} [${toAmpersandType(sourceType)}*${toAmpersandType(targetType)}]`);
        lines.push(`POPULATION ${toAmpersandType(relType)} [${toAmpersandType(sourceType)}*${toAmpersandType(targetType)}] CONTAINS [`);
        lines.push(population.join(',\n'));
        lines.push(']\n');
    });

    // Add footer
    lines.push('ENDCONTEXT')

    return lines.join('\n');
}

/**
 * Determines which rules should be checked, given the `relationships`.
 */
function getRelevantRules(elements, relationships){
    function getRelationshipLevels(relationshipType, sourceType, targetType) {
        const relationShipLevels = [];

        if (relationshipType) {
            relationShipLevels.push(
                ...relationships
                .filter(r => r.type === relationshipType && r.source.type === sourceType && r.target.type === targetType)
                .flatMap(r => [r.source.prop(LEVEL), r.target.prop(LEVEL)])
            );

            // Consider the relationship to exist if source and target types are identical
            // and only one element of that type exists at the given level.
            if (sourceType === targetType) {
                SUPPORTED_LEVELS.forEach(level => {
                    if (
                        elements
                        .filter(e => e.type === sourceType && e.prop(LEVEL) === level)
                        .length === 1
                    ) {
                        relationShipLevels.push(level);
                    }
                });
            }
        } else {
            relationShipLevels.push(...relationships.flatMap(r => [r.source.prop(LEVEL), r.target.prop(LEVEL)]));
        }

        return [...new Set(relationShipLevels)];
    }

    function selectRule(ruleName, relationshipTypes) {
        if (relationshipTypes.every(type => levels[type].length > 0 && levels[type].length === levels.all.length)) {
            selectedRules.push(ruleName);
        } else {
            levels.all.forEach(level => {
                if (relationshipTypes.every(type => levels[type].includes(level))) {
                    selectedRules.push(ruleName + '_L' + level);
                }
            });
        }
    }

    const levels = {
        access: getRelationshipLevels('access-relationship', 'business-function', 'business-object'),
        aggregation: getRelationshipLevels('aggregation-relationship', 'business-function', 'business-process'),
        association: getRelationshipLevels('association-relationship', 'business-object', 'business-object'),
        serving: getRelationshipLevels('serving-relationship', 'business-function', 'business-function'),
        processComposition: getRelationshipLevels('composition-relationship', 'business-process', 'business-process'),
        all: getRelationshipLevels()
    }

    const selectedRules = [];

    selectedRules.push('C0'); // level prop
    selectedRules.push('C1'); // one parent
    selectedRules.push('C2'); // acyclic
    selectedRules.push('C3'); // universal level

    [['a', 'access'], ['g', 'aggregation'], ['o', 'association'], ['v', 'serving']]
    .forEach(([symbol, type]) => {
        if (levels[type].length > 1) {
            selectedRules.push(`C4_${symbol}`); // inheritance upward
            selectedRules.push(`C5_${symbol}`); // exists downward
        }
    });

    selectRule('C6', ['access']); // must access
    selectRule('C7', ['access']); // must be accessed
    selectRule('C8', ['aggregation', 'serving']); // eventually aggregates
    selectRule('C9', ['aggregation']); // aggregated exactly once
    selectRule('C10', ['access', 'aggregation', 'association', 'processComposition', 'serving']); // association allowed
    selectRule('C11', ['access', 'aggregation', 'association', 'processComposition', 'serving']); // shared object
    selectRule('C12', ['access', 'aggregation', 'association', 'processComposition', 'serving']); // serving mirrorred
    selectRule('C13', ['access', 'aggregation', 'association', 'processComposition', 'serving']); // connected graph

    return selectedRules;
}

/**
 * Returns the content of a rules file, given the `selectedRules`.
 * If `selectedRules` is not provided, returns all rules (excluding their levelled versions).
 * If `standalone` is true, the rules are in a format suited for testing ARCHIMATE files with Ampersand.
 */
function getRuleContent(standalone, selectedRules) {
    const el = 'Element';
    const bf = 'BusinessFunction';
    const bo = 'BusinessObject';
    const bp = 'BusinessProcess';

    const I = type => `I[${type}]`;
    const V = type => `V[${type}]`;
    const a = `access[${bf}*${bo}]`;
    const c = type => `composition[${type}]`;
    const g = `aggregation[${bf}*${bp}]`;
    const o = standalone ?
        '(source[Relationship*BusinessObject]~;(type[Relationship*Text];"association";type[Relationship*Text]~ /\\ I[Relationship]);target[Relationship*BusinessObject])' :
        `association[${bo}]`;
    const v = `serving[${bf}]`;

    const prop = (key, value) => `propOf[Property*ArchiObject]~;(I[Property] /\\ key[Property*Text];${key};key[Property*Text]~);value[Property*Text];${value ? value + ';' : ''}value[Property*Text]~;propOf[Property*ArchiObject]`;
    const L = level => {
        const key = `"${escapeText(LEVEL)}"`;
        let value;
        if (level !== undefined) {
            value = Array.isArray(level) ? `("${level.map(l => escapeText(l)).join('"\\/"')}")` : `"${escapeText('' + level)}"`;
        }
        return standalone ?
            prop(key, value) :
            `level[Element*Level];${value ? value + ';' : ''}level[Element*Level]~`;
    }

    const M = meaning => `MEANING {+ ${meaning} +}\n            VIOLATION (TXT "(", SRC name[ArchiObject*Text], TXT ", ", TGT name[ArchiObject*Text], TXT ")")\n\n`;

    function addLevelledRule(id, label, term, meaning) {
        rules[id] = (rules[id] || '') + 
            `RULE ${label}:
            ${term}
            ${M(meaning)}`;

        SUPPORTED_LEVELS.forEach(level => {
            const id_l = `${id}_L${level}`;
            rules[id_l] = (rules[id_l] || '') +
                `RULE ${label}_L${level}:
                ${term.replace('|-', '/\\ ' + L(level) + ' |-')}
                ${M('At level ' + level + ': ' + meaning)}`;
        });
    }

    const rules = {};

    // C0
    rules.C0 = `RULE C0_supported_level_assigned:
        ${I(el)} |- ${L(SUPPORTED_LEVELS)}
        ${M('Each element has a supported decomposition level assigned.')}`;

        SUPPORTED_LEVELS.forEach((level, index) => {
            if (index === 0) return;
            const parentLevel = SUPPORTED_LEVELS[index - 1];
            rules.C0 += `RULE C0_L${level}_composed_by_L${parentLevel}:
                ${I(el)} /\\ ${L(level)} |- (${I(el)} - (${c(el)}~;${c(el)})) \\/ (${I(el)} /\\ ${c(el)}~;${L(parentLevel)};${c(el)})
                ${M('Each element at level ' + level + ' has no parent or a parent at level ' + parentLevel + '.')}`;
    });

    // C1
    rules.C1 = `RULE C1_one_parent:
        ${c(el)};${c(el)}~ |- ${I(el)}
        ${M('Each element has at most one parent.')}`;

    // C2
    rules.C2 = `RULE C2_acyclic:
        ${c(el)}+ |- -${I(el)}
        ${M('No element can be its own ancestor.')}`;

    // C3
    rules.C3 = '';
    [bf, bo, bp].forEach(type => {
        rules.C3 += `RULE C3_shared_root_level_${type}:
            (${I(type)}-${c(type)}~;${c(type)});${V(type)};(${I(type)}-${c(type)}~;${c(type)}) |- ${L()}
            ${M('All root ' + type + ' elements share the same decomposition level.')}`;
        rules.C3 += `RULE C3_shared_leaf_level_${type}:
            (${I(type)}-${c(type)};${c(type)}~);${V(type)};(${I(type)}-${c(type)};${c(type)}~) |- ${L()}
            ${M('All leaf ' + type + ' elements share the same decomposition level.')}`;
    });

    [[a, 'a', 'access'], [g, 'g', 'aggregation'], [v, 'v', 'serving']]
    .forEach(([term, symbol, type]) => {
        // C4
        if (type === 'serving') {
            rules['C4_' + symbol] = `RULE C4_${type}_inherited_upward:
                ${c(el)};${term};${c(el)}~ |- ${I(el)} \\/ ${term} \\/ ${g};${c(bp)}~+;${c(bp)}+;${g}~
                ${M('If two elements have a(n) ' + type + ' relationship, their parents (if any) must as well.')}`;
        } else {
            rules['C4_' + symbol] = `RULE C4_${type}_inherited_upward:
                ${c(el)};${term};${c(el)}~ |- ${I(el)} \\/ ${term}
                ${M('If two elements have a(n) ' + type + ' relationship, their parents (if any) must as well.')}`;
        }

        // C5
        rules['C5_' + symbol] = `RULE C5_${type}_exists_downward:
            ${term} |- ${c(el)};${term};${c(el)}~ \\/ (${I(el)}-${c(el)};${c(el)}~);${term};(${I(el)}-${c(el)};${c(el)}~)
            ${M('If two elements have a(n) ' + type + ' relationship, at least one pair of children (if any) must as well.')}`;
    });

    // C6
    addLevelledRule('C6', 'C6_function_must_access_object',
        `${I(bf)} |- ${a};${a}~`,
        'Each business function must access at least one business object.'
    );

    // C7
    addLevelledRule('C7', 'C7_object_is_accessed',
        `${I(bo)} |- ${a}~;${a}`,
        'Each business object must be accessed by at least one business function.'
    );

    // C8
    addLevelledRule('C8', 'C8_function_eventually_aggregates_process',
        `${I(bf)} |- (${I(bf)} \\/ ${v}+);${g};${g}~;(${I(bf)} \\/ ${v}~+)`,
        'Each business function must either (1) aggregate a business process or (2) serve another function, potentially through multiple serving relationships, that aggregates a business process.'
    );

    // C9
    addLevelledRule('C9', 'C9_process_is_aggregated',
        `${I(bp)} |- ${g}~;${g}`,
        'Each business process must be aggregated by at least one business function.'
    );
    addLevelledRule('C9', 'C9_process_aggregated_only_once',
        `${g};${g}~ |- ${I(bf)}`,
        'Each business process must be aggregated by at most one business function.'
    );

    // C10
    addLevelledRule('C10', 'C10_association_allowed',
        `${o} |- ${a}~;(${I(bf)} \\/ ${v}~ \\/ ${g};${c(bp)}~+;${c(bp)}+;${g}~);${a}`,
        'An association relationship between business objects is allowed if they are accessed (1) by the same business function, (2) by functions with a serving relationship in the opposite direction, or (3) by functions that aggregate business processes with a common ancestor.'
    );

    // C11
    addLevelledRule('C11', 'C11_shared_object',
        `${a};${a}~ |- ${I(bf)} \\/ (${v} \\/ ${v}~);${a};${a}~ \\/ ${g};${c(bp)}~+;${c(bp)}+;${g}~`,
        'Business functions that access a common business object must (1) have a serving relationship to at least one other business function that accesses the same object, or (2) aggregate busines processes with a common ancestor.'
    );

    // C12
    addLevelledRule('C12', 'C12_serving_mirrorred_by_association',
        `${v} |- ${a};(${I(bo)} \\/ ${o}~);${a}~`,
        'Each serving relationship between business functions must have a corresponding association relationship between business objects in the opposite direction.'
    );

    // C13
    addLevelledRule('C13', 'C13_connected_graph',
        `${c(bp)}~+;${c(bp)}+ /\\ ${L()} |- ${g}~;${a};(${I(bo)} \\/ (${o} \\/ ${o}~)+);${a}~;${g}`,
        'At least one business object per descendant of a business process must be part of a connected graph.'
    );

    const lines = [];

    // Add header
    lines.push(`CONTEXT Rules

    INCLUDE "${standalone ? 'model.archimate' : MODEL_FILE}"

    CLASSIFY ${bf} ISA ${el}
    CLASSIFY ${bo} ISA ${el}
    CLASSIFY ${bp} ISA ${el}
    CLASSIFY ${el} ISA Concept
    CLASSIFY Concept ISA ArchiObject

    RELATION ${a}
    RELATION ${g}
    RELATION ${c(bf)}
    RELATION ${c(bo)}
    RELATION ${c(bp)}
    RELATION ${c(el)}
    RELATION ${v}
    RELATION name[ArchiObject*Text] [UNI]
    `);
    if (standalone) {
        lines.push(`
            RELATION source[Relationship*BusinessObject]
            RELATION target[Relationship*BusinessObject]
            RELATION type[Relationship*Text]
            RELATION propOf[Property*ArchiObject] [UNI]
            RELATION key[Property*Text] [UNI]
            RELATION value[Property*Text] [UNI]
        `);
    } else {
        lines.push(`
            RELATION ${o}
            RELATION level[Element*Level]
        `);
    }

    // Add rules
    if (selectedRules) { // only the selected rules
        selectedRules.forEach(s => lines.push(rules[s]));
    } else {
        Object.keys(rules)
        .filter(key => !/^C\d+_L\d+$/.test(key)) // all rules except their levelled versions
        .forEach(s => lines.push(rules[s]));
    }

    // Add footer
    lines.push('ENDCONTEXT');

    return lines.join('\n');
}

/**
 * Executes the Ampersand process and shows its output in the console.
 */
function runAmpersand() {
    const File = Java.type('java.io.File');
    const ProcessBuilder = Java.type('java.lang.ProcessBuilder');
    const BufferedReader = Java.type('java.io.BufferedReader');
    const InputStreamReader = Java.type('java.io.InputStreamReader');

    const ampersand = __DIR__ + AMPERSAND + '/ampersand';
    const pb = new ProcessBuilder(ampersand, 'check', RULES_FILE);
    pb.directory(new File(__DIR__ + OUTPUT));

    try {
        const process = pb.start();

        const reader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
        let line = null;
        while ((line = reader.readLine()) !== null) {
            console.log(line);
        }
    } catch (e) {
        console.log('Failed to run Ampersand: ' + e);
    }
}

function getUniqueConcepts(collection, type) {
    const concepts = [];
    const seen = [];
    $(collection).find(type).each(i => {
        const c = i.concept;
        if (c && !seen.includes(c.id)) {
            seen.push(c.id);
            concepts.push(c);
        }
    });
    return concepts;
}

const options = {
    full: 'FULL: validate full model against all rules',
    partial: 'PARTIAL: validate selection against applicable rules',
    standalone: 'STANDALONE: create a standalone ADL file to validate ARCHIMATE files'
};
const choice = '' + window.promptSelection(NAME, Object.values(options));

if (choice === options.partial || choice === options.full) {
    const collection = choice === options.full ? model : selection;
    const elements = getUniqueConcepts(collection, 'element');
    const relationships = getUniqueConcepts(collection, 'relationship');

    if (window.confirm(`${$(collection)} contains ${elements.length} elements and ${relationships.length} relationships.\n\nContinue with validation?`)) {
        console.clear();
        console.show();

        const modelContent = getModelContent(elements, relationships);
        $.fs.writeFile(__DIR__ + OUTPUT + '/' + MODEL_FILE, modelContent, 'UTF8');

        const relevantRules = choice === options.partial ? getRelevantRules(elements, relationships) : undefined;
        const ruleContent = getRuleContent(false, relevantRules);
        $.fs.writeFile(__DIR__ + OUTPUT + '/' + RULES_FILE, ruleContent, 'UTF8');

        console.log(`Validating ${elements.length} elements and ${relationships.length} relationships in ${$(collection)} against ${relevantRules ? relevantRules.join(', ') : 'all rules'}:\n`);
        runAmpersand();
        console.log(`\nValidation completed.`)
    }
}

if (choice === options.standalone) {
    const ruleContent = getRuleContent(true);
    const filePath = __DIR__ + OUTPUT + '/' + STANDALONE_FILE;
    $.fs.writeFile(filePath, ruleContent, 'UTF8');
    window.alert(
        'File written: ' + filePath + '\n\n' +
        'Update the INCLUDE statement to point to your ARCHIMATE file.\n\n' +
        'To validate your model, execute the command: ampersand check ' + STANDALONE_FILE
    );
}
