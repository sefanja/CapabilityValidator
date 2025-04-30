const OUTPUT = 'output';
const AMPERSAND = 'ampersand';
const MODEL_FILE = 'model.adl';
const RULES_FILE = 'rules.adl';
const LEVEL = 'Level';
const MAX_LEVEL = 4;
const SUPPORTED_LEVELS = [...Array(MAX_LEVEL + 1).keys()].map(String);

function escapeText(text) {
    return text ? text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : '';
}

function writeToFile(content, name) {
    try {
        const Paths = Java.type('java.nio.file.Paths');
        const filePath = Paths.get(__DIR__, OUTPUT, name).toString();
        const FileWriter = Java.type('java.io.FileWriter');
        const BufferedWriter = Java.type('java.io.BufferedWriter');
        const writer = new BufferedWriter(new FileWriter(filePath));
        writer.write(content);
        writer.close();
    } catch (e) {
        console.log('Error writing to file: ' + filePath);
        console.log(e);
    }
}

/**
 * Transforms all elements and relationships in `collection` to Ampersand format.
 */
function getModelContent(elements, relationships) {
    function toAmpersandType(s) {
        if (s.endsWith('-relationship')) return s.split('-')[0];
        return s.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
    }

    const lines = [];

    // Add header
    lines.push('CONTEXT Model');

    // Add elements names
    const elementTypes = [...new Set(elements.map(e => e.type))];
    elementTypes.forEach(type => {
        const population = elements.filter(e => e.type === type)
            .map(e => `    ( "${e.id}" , "${escapeText(e.name)}" )`);
        lines.push(`RELATION name [${toAmpersandType(type)}*Text]  [UNI]`);
        lines.push(`POPULATION name [${toAmpersandType(type)}*Text] CONTAINS [`);
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

    // Add properties
    const propOf = [];
    const propKey = [];
    const propValue = [];

    let propertyCounter = 0;

    for (const e of elements) {
        const key = LEVEL;
        const values = e.prop(key, true);
        if (values) {
            for (const value of values) {
                const propId = `pr-${propertyCounter++}`;

                propOf.push(`    ( "${propId}" , "${e.id}" )`);
                propKey.push(`    ( "${propId}" , "${escapeText(key)}" )`);
                propValue.push(`    ( "${propId}" , "${escapeText(value)}" )`);
            }
        }
    }

    if (propOf.length > 0) {
        lines.push('RELATION propOf [Property*ArchiObject] [UNI]');
        lines.push('POPULATION propOf [Property*ArchiObject] CONTAINS [');
        lines.push(propOf.join(',\n'));
        lines.push(']\n');

        lines.push('RELATION key [Property*Text] [UNI]');
        lines.push('POPULATION key [Property*Text] CONTAINS [');
        lines.push(propKey.join(',\n'));
        lines.push(']\n');

        lines.push('RELATION value [Property*Text] [UNI]');
        lines.push('POPULATION value [Property*Text] CONTAINS [');
        lines.push(propValue.join(',\n'));
        lines.push(']\n');
    }

    // Add footer
    lines.push('ENDCONTEXT')

    return lines.join('\n');
}

/**
 * Determines which rules should be checked, given the elements and relationships in `collection`.
 */
function getRuleSelection(relationships){
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
        if (relationshipTypes.every(type => levels[type].length === levels.all.length)) {
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

    // C0 (level prop)
    selectedRules.push('C0');

    // C1 (one parent)
    selectedRules.push('C1');

    // C2 (acyclic)
    selectedRules.push('C2');

    // C3 (universal level)
    selectedRules.push('C3');

    // C4 (inheritance upward)
    // C5 (exists downward)
    ['access', 'aggregation', 'association', 'serving'].forEach(type => {
        if (levels[type].length > 1) {
            selectedRules.push(`C4_${type}`);
            selectedRules.push(`C5_${type}`);
        }
    });

    // C6 (must access)
    selectRule('C6', ['access']);

    // C7 (must be accessed)
    selectRule('C7', ['access']);

    // C8 (aggregated exactly once)
    selectRule('C8', ['aggregation']);

    // C9 (eventually aggregates)
    selectRule('C9', ['aggregation', 'serving']);

    // C10 (association allowed)
    selectRule('C10', ['access', 'aggregation', 'association', 'processComposition', 'serving']);

    // C11 (shared object)
    if ($(selection).first().type === 'archimate-model') {
        selectRule('C11', ['access', 'aggregation', 'association', 'processComposition', 'serving']);
    }

    // C12 (serving mirrorred)
    selectRule('C12', ['access', 'aggregation', 'association', 'processComposition', 'serving']);

    // C13 (connected graph)
    selectRule('C13', ['access', 'aggregation', 'association', 'processComposition', 'serving']);

    return selectedRules;
}

/**
 * Returns the content of a rules file, given the `selection` of rules.
 */
function getRuleContent(selection) {
    const el = 'Element';
    const bf = 'BusinessFunction';
    const bo = 'BusinessObject';
    const bp = 'BusinessProcess';

    const I = type => `I[${type}]`;
    const V = type => `V[${type}]`;
    const a = `access[${bf}*${bo}]`;
    const c = type => `composition[${type}]`;
    const g = `aggregation[${bf}*${bp}]`;
    const o = `association[${bo}]`;
    // When using INCLUDE "model.archimate" directly instead of the "model.adl" generated by this script,
    // Ampersand exports association relationship names as relation types.
    // Therefore this term: association[BusinessObject]
    // must be replaced by: source[Relationship*BusinessObject]~;(type[Relationship*Text];"association";type[Relationship*Text]~ /\ I[Relationship]);target[Relationship*BusinessObject]
    const v = `serving[${bf}]`;

    const prop = (key, value) => `propOf[Property*ArchiObject]~;(I[Property] /\\ key[Property*Text];${key};key[Property*Text]~);value[Property*Text];${value ? value + ';' : ''}value[Property*Text]~;propOf[Property*ArchiObject]`;
    const L = level => {
        const key = `"${escapeText(LEVEL)}"`;
        let value;
        if (level !== undefined) {
            value = Array.isArray(level) ? `("${level.map(l => escapeText(l)).join('"\\/"')}")` : `"${escapeText('' + level)}"`;
        }
        return prop(key, value);
    }

    const M = meaning => `MEANING {+ ${meaning} +}\n            VIOLATION (TXT "(", SRC name[ArchiObject*Text], TXT ", ", TGT name[ArchiObject*Text], TXT ")")\n\n`;

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

    Object.entries({access: a, aggregation: g, association: o, serving: v}).forEach(([key, value]) => {
        // C4
        rules['C4_' + key] = `RULE C4_${key}_inherited_upward:
            ${c(el)};${value};${c(el)}~ |- ${I(el)} \\/ ${value}
            ${M('If two elements have a(n) ' + key + ' relationship, their parents (if any) must as well.')}`;

        // C5
        rules['C5_' + key] = `RULE C5_${key}_exists_downward:
            ${value} |- ${c(el)};${value};${c(el)}~ \\/ (${I(el)}-${c(el)};${c(el)}~);${value};(${I(el)}-${c(el)};${c(el)}~)
            ${M('If two elements have a(n) ' + key + ' relationship, at least one pair of children (if any) must as well.')}`;
    });

    // C6
    rules.C6 = `RULE C6_function_must_access_object:
    ${I(bf)} |- ${a};${a}~
    ${M('Each business function must access at least one business object.')}`;

    // C7
    rules.C7 = `RULE C7_object_is_accessed:
        ${I(bo)} |- ${a}~;${a}
        ${M('Each business object must be accessed by at least one business function.')}`;

    // C8
    rules.C8 = `RULE C8_process_is_aggregated:
        ${I(bp)} |- ${g}~;${g}
        ${M('Each business process must be aggregated by at least one business function.')}`;
    rules.C8 += `RULE C8_process_aggregated_only_once:
        ${g};${g}~ |- ${I(bf)}
        ${M('Each business process must be aggregated by at most one business function.')}`;

    // C9
    rules.C9 = `RULE C9_function_eventually_aggregates_process:
        ${I(bf)} |- (${I(bf)} \\/ ${v}+);${g};${g}~;(${I(bf)} \\/ ${v}~+)
        ${M('Each business function must either (1) aggregate a business process or (2) serve another function, potentially through multiple serving relationships, that aggregates a business process.')}`;

    // C10
    rules.C10 = `RULE C10_association_allowed:
        ${o} |- ${a}~;(${I(bf)} \\/ ${v}~ \\/ ${g};${c(bp)}~+;${c(bp)}+;${g}~);${a}
        ${M('An association relationship between business objects is allowed if they are accessed (1) by the same business function, (2) by functions with a serving relationship in the opposite direction, or (3) by functions that aggregate business processes with a common ancestor.')}`;

    // C11
    rules.C11 = `RULE C11_shared_object:
        ${a};${a}~ |- ${I(bf)} \\/ (${v} \\/ ${v}~);${a};${a}~ \\/ ${g};${c(bp)}~+;${c(bp)}+;${g}~
        ${M('Business functions that access a common business object must (1) have a serving relationship to at least one other business function that accesses the same object, or (2) aggregate busines processes with a common ancestor.')}`;

    // C12
    rules.C12 = `RULE C12_serving_mirrorred_by_access:
        ${v} |- ${a};(${I(bo)} \\/ ${o}~);${a}~
        ${M('Each serving relationship between business functions must have a corresponding association relationship between business objects in the opposite direction.')}`;

    // C13
    rules.C13 = `RULE C13_connected_graph:
        ${c(bp)}~+;${c(bp)}+ /\\ ${L()} |- ${g}~;${a};(${I(bo)} \\/ (${o} \\/ ${o}~)+);${a}~;${g}
        ${M('At least one business object per descendant of a business process must be part of a connected graph.')}`;

    SUPPORTED_LEVELS.forEach(level => {
        // C6
        rules[`C6_L${level}`] = `RULE C6_function_must_access_object_L${level}:
            ${I(bf)} /\\ ${L(level)} |- ${a};${a}~
            ${M('At level ' + level + ', each business function must access at least one business object.')}`;

        // C7
        rules[`C7_L${level}`] = `RULE C7_object_is_accessed_L${level}:
            ${I(bo)} /\\ ${L(level)} |- ${a}~;${a}
            ${M('At level ' + level + ', each business object must be accessed by at least one business function.')}`;

        // C8
        rules[`C8_L${level}`] = `RULE C8_process_is_aggregated_L${level}:
            ${I(bp)} /\\ ${L(level)} |- ${g}~;${g}
            ${M('At level ' + level + ', each business process must be aggregated by at least one business function.')}`;
        rules[`C8_L${level}`] += `RULE C8_process_aggregated_only_once_L${level}:
            ${g};${g}~ /\\ ${L(level)} |- ${I(bf)}
            ${M('At level ' + level + ', each business process must be aggregated by at most one business function.')}`;

        // C9
        rules[`C9_L${level}`] = `RULE C9_function_eventually_aggregates_process_L${level}:
            ${I(bf)} /\\ ${L(level)} |- (${I(bf)} \\/ ${v}+);${g};${g}~;(${I(bf)} \\/ ${v}~+)
            ${M('At level ' + level + ', each business function must either (1) aggregate a business process or (2) serve another function, potentially through multiple serving relationships, that aggregates a business process.')}`;

        // C10
        rules[`C10_L${level}`] = `RULE C10_association_allowed_L${level}:
            ${o} /\\ ${L(level)} |- ${a}~;(${I(bf)} \\/ ${v}~ \\/ ${g};${c(bp)}~+;${c(bp)}+;${g}~);${a}
            ${M('At level ' + level + ', an association relationship between business objects is allowed if they are accessed (1) by the same business function, (2) by functions with a serving relationship in the opposite direction, or (3) by functions that aggregate business processes with a common ancestor.')}`;

        // C11
        rules[`C11_L${level}`] = `RULE C11_shared_object_L${level}:
            ${a};${a}~ /\\ ${L(level)} |- ${I(bf)} \\/ (${v} \\/ ${v}~);${a};${a}~ \\/ ${g};${c(bp)}~+;${c(bp)}+;${g}~
            ${M('At level ' + level + ', business functions that access a common business object must (1) have a serving relationship to at least one other business function that accesses the same object, or (2) aggregate busines processes with a common ancestor.')}`;

        // C12
        rules[`C12_L${level}`] = `RULE C12_serving_mirrorred_by_access_L${level}:
            ${v} /\\ ${L(level)} |- ${a};(${I(bo)} \\/ ${o}~);${a}~
            ${M('At level ' + level + ', each serving relationship between business functions must have a corresponding association relationship between business objects in the opposite direction.')}`;

        // C13
        rules[`C13_L${level}`] = `RULE C13_connected_graph_L${level}:
            ${c(bp)}~+;${c(bp)}+ /\\ ${L(level)} |- ${g}~;${a};(${I(bo)} \\/ (${o} \\/ ${o}~)+);${a}~;${g}
            ${M('At level ' + level + ', at least one business object per descendant of a business process must be part of a connected graph.')}`;
    });

    const lines = [];

    // Add header
    lines.push(`CONTEXT Rules

    INCLUDE "${MODEL_FILE}"

    CLASSIFY ${bf} ISA ${el}
    CLASSIFY ${bo} ISA ${el}
    CLASSIFY ${bp} ISA ${el}
    CLASSIFY ${el} ISA Concept
    CLASSIFY Concept ISA ArchiObject

    RELATION ${a}
    RELATION ${g}
    RELATION ${o}
    RELATION ${c(bf)}
    RELATION ${c(bo)}
    RELATION ${c(bp)}
    RELATION ${c(el)}
    RELATION ${v}
    RELATION key[Property*Text] [UNI]
    RELATION name[ArchiObject*Text] [UNI]
    RELATION propOf[Property*ArchiObject] [UNI]
    RELATION value[Property*Text] [UNI]`);

    // Add selected rules
    selection.forEach(s => lines.push(rules[s]));

    // Add footer
    lines.push('ENDCONTEXT');

    return lines.join('\n');
}

/**
 * Executes the Ampersand process and shows its output in the console.
 */
function runAmpersand() {
    const Paths = Java.type('java.nio.file.Paths');
    const File = Java.type('java.io.File');
    const ProcessBuilder = Java.type('java.lang.ProcessBuilder');
    const BufferedReader = Java.type('java.io.BufferedReader');
    const InputStreamReader = Java.type('java.io.InputStreamReader');

    const ampersand = Paths.get(__DIR__, AMPERSAND, 'ampersand.exe').toString();
    const pb = new ProcessBuilder(ampersand, 'check', RULES_FILE);
    pb.directory(new File(Paths.get(__DIR__, OUTPUT)));

    try {
        console.log('Running Ampersand:\n');

        const process = pb.start();

        const reader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
        let line = null;
        while ((line = reader.readLine()) != null) {
            console.log('> ' + line);
        }

        const exitCode = process.waitFor();
        console.log('\nAmpersand completed with exit code ' + exitCode);

    } catch (e) {
        console.log('Failed to run Ampersand: ' + e);
    }
}

console.clear();
console.show();

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

const elements = getUniqueConcepts(selection, 'element');
const relationships = getUniqueConcepts(selection, 'relationship');

console.log(`Checking consistency of concepts in ${$(selection)}\n`);

const modelContent = getModelContent(elements, relationships);
writeToFile(modelContent, MODEL_FILE);
console.log(`Written ${MODEL_FILE} with ${elements.length} elements and ${relationships.length} relationships\n`);

const selectedRules = getRuleSelection(relationships);
const ruleContent = getRuleContent(selectedRules);
writeToFile(ruleContent, RULES_FILE);
console.log(`Written ${RULES_FILE} with rules ${selectedRules.join(', ')}\n`);

runAmpersand();
