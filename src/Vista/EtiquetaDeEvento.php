<?php

namespace Muni\Arcop\Vista;

/**
 * Cómo se lee cada evento de la bitácora en la línea de tiempo del caso.
 *
 * Las claves (`solicitud.registrada`, `arcop.expediente.descargado`) son para
 * la máquina; en pantalla van en castellano. El evento desconocido no se
 * oculta ni revienta: se pinta legible a partir de la clave, para que una
 * entrada nueva del módulo se vea aunque este catálogo no la conozca todavía.
 */
final class EtiquetaDeEvento
{
    public static function de(string $evento): string
    {
        return match ($evento) {
            'solicitud.registrada' => 'Recepción de la solicitud',
            'solicitud.acogida' => 'Solicitud acogida',
            'solicitud.acogida_parcial' => 'Solicitud acogida parcialmente',
            'solicitud.rechazada' => 'Solicitud rechazada',
            'bloqueo.aplicado' => 'Bloqueo del tratamiento',
            'bloqueo.levantado' => 'Bloqueo levantado',
            'bloqueo.definitivo' => 'Bloqueo definitivo',
            'datos.exportados' => 'Copia de los datos generada',
            'informacion.entregada' => 'Información entregada al titular',
            'rectificacion.aplicada' => 'Rectificación aplicada',
            'rectificacion.fallida' => 'Rectificación fallida',
            'supresion.aplicada' => 'Supresión aplicada',
            'supresion.parcial' => 'Supresión parcial',
            'supresion.fallida' => 'Supresión fallida',
            'retencion.aplicada' => 'Retención aplicada',
            'consentimiento.otorgado' => 'Consentimiento otorgado',
            'consentimiento.revocado' => 'Consentimiento revocado',
            'brecha.registrada' => 'Brecha registrada',
            'arcop.titulares.buscados' => 'Búsqueda de titulares',
            'arcop.titular.consultado' => 'Ficha del titular consultada',
            'arcop.expediente.descargado' => 'Expediente descargado',
            default => ucfirst(str_replace(['.', '_'], ' ', $evento)),
        };
    }
}
