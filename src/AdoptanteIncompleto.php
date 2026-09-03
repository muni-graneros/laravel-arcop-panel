<?php

namespace Muni\Arcop;

use RuntimeException;

/**
 * Lo que falta enchufar, dicho en una frase que se puede accionar.
 *
 * Sin esto, un sistema que instala el paquete y no enchufa sus contratos recibe
 * un «Target [...] is not instantiable» del contenedor, que no le dice a nadie
 * qué hacer. Y el momento en que aparece es el peor posible: un funcionario
 * frente a un vecino en el mesón.
 */
class AdoptanteIncompleto extends RuntimeException
{
    public static function faltaElBuscador(): self
    {
        return new self(
            'Este sistema no declaró cómo busca a los titulares que atiende. Enlazá una implementación de '
            .'Muni\Shared\Privacidad\Contratos\BuscaTitulares en el contenedor (por ejemplo en AppServiceProvider): '
            .'el panel conoce el contrato, no el esquema de personas de este sistema.',
        );
    }

    public static function faltaElVerificador(): self
    {
        return new self(
            'Este sistema no declaró qué cuenta como identidad acreditada en su mesón. Enlazá una implementación '
            .'de Muni\Shared\Privacidad\Contratos\VerificadorIdentidad en el contenedor. Sin eso no se puede '
            .'recibir una solicitud: entregar datos personales a quien no acreditó ser el titular es la fuga más '
            .'fácil de cometer.',
        );
    }

    public static function faltaElDiscoDeEvidencia(): self
    {
        return new self(
            'Este sistema no declaró en qué disco guarda los documentos de evidencia (privacidad.disco_evidencia, '
            .'PRIVACIDAD_DISCO_EVIDENCIA). Sin eso el panel no guarda el documento que acredita la representación '
            .'en cualquier parte: el módulo lo borra de ESE disco al suprimir al titular, y un documento guardado '
            .'en otro se vuelve un dato personal perdido que nadie puede encontrar para suprimir.',
        );
    }
}
